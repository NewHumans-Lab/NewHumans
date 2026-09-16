import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { withTransaction } from '../db.js';
import { appendEvent, hashPayload, resolveActor } from './core.js';
import { releaseReservation, settleReservation } from './economy.js';

const ONE_MILLION = 1_000_000n;
const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const CONFIRMED_CONNECT_FAILURES = new Set(['ENOTFOUND', 'ECONNREFUSED']);
const BLOCKED_CONNECTOR_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.google.internal.', '100.100.100.200']);
const ACTION_PURPOSES = new Set(['PRIMARY_INFERENCE', 'AUXILIARY_INFERENCE']);
const DISPATCH_BLOCK_CODES = new Set(['UNAUTHENTICATED','WORLD_MISMATCH','STALE_ACTIVITY_TICKET','DAILY_FEE_REQUIRED','NO_AVAILABLE_ENERGY','GATEWAY_NOT_AVAILABLE','INVALID_RESERVATION','RESERVATION_TOO_SMALL','EXECUTION_NOT_DISPATCHABLE']);

function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function parseNonNegativeMicroE(value, field = 'amount') {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw problem('INVALID_AMOUNT', `${field} must be a non-negative decimal integer string`);
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) throw problem('INVALID_AMOUNT', `${field} exceeds bigint range`);
  return parsed;
}

function parsePositiveInt(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw problem('INVALID_GATEWAY_INPUT', `${field} must be a positive integer`);
  return value;
}

function ceilDiv(numerator, denominator) {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

export function calculateUsageCharge({ inputTokens, outputTokens, inputRateMicroEPerMillion, outputRateMicroEPerMillion }) {
  const input = BigInt(inputTokens);
  const output = BigInt(outputTokens);
  const inputRate = BigInt(inputRateMicroEPerMillion);
  const outputRate = BigInt(outputRateMicroEPerMillion);
  if (input < 0n || output < 0n || inputRate < 0n || outputRate < 0n) throw problem('INVALID_USAGE', 'usage and rates must be non-negative');
  return ceilDiv(input * inputRate, ONE_MILLION) + ceilDiv(output * outputRate, ONE_MILLION);
}

export function validateConnectorBaseUrl(baseUrl, connectorKind) {
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw problem('INVALID_CONNECTOR_URL', 'baseUrl must be an absolute URL'); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw problem('INVALID_CONNECTOR_URL', 'baseUrl cannot include credentials, query or fragment');
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_CONNECTOR_HOSTS.has(hostname) || hostname.startsWith('169.254.')) throw problem('INVALID_CONNECTOR_URL', 'link-local/cloud metadata endpoints are forbidden');
  if (connectorKind === 'CLOUD' && parsed.protocol !== 'https:') throw problem('INVALID_CONNECTOR_URL', 'CLOUD connectors require https');
  if (connectorKind === 'LOCAL_SELF_HOSTED' && !['http:', 'https:'].includes(parsed.protocol)) throw problem('INVALID_CONNECTOR_URL', 'LOCAL_SELF_HOSTED connectors require http or https');
  if (!['CLOUD', 'LOCAL_SELF_HOSTED'].includes(connectorKind)) throw problem('INVALID_CONNECTOR_KIND', 'unsupported connector kind');
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 128) throw problem('INVALID_GATEWAY_INPUT', 'messages must contain 1..128 items');
  return messages.map((message) => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length === 0 || message.content.length > 100_000) {
      throw problem('INVALID_GATEWAY_INPUT', 'each message requires role system/user/assistant and non-empty content');
    }
    return { role: message.role, content: message.content };
  });
}

export function conservativeInputTokenUpperBound(messages) {
  const normalized = normalizeMessages(messages);
  const bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
  const bound = bytes + 32 + normalized.length * 16;
  if (!Number.isSafeInteger(bound)) throw problem('MODEL_INPUT_LIMIT_EXCEEDED', 'input is too large to bound safely', 409);
  return bound;
}

function normalizeTemperature(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) throw problem('INVALID_GATEWAY_INPUT', 'temperature must be a finite number between 0 and 2');
  return value;
}

function normalizeActionPurpose(value) {
  const purpose = value ?? 'PRIMARY_INFERENCE';
  if (!ACTION_PURPOSES.has(purpose)) throw problem('INVALID_ACTION_PURPOSE', 'actionPurpose must be PRIMARY_INFERENCE or AUXILIARY_INFERENCE');
  return purpose;
}

export function extractOpenAICompatibleUsage(payload) {
  const usage = payload?.usage;
  const input = usage?.prompt_tokens ?? usage?.input_tokens;
  const output = usage?.completion_tokens ?? usage?.output_tokens;
  if (!Number.isInteger(input) || input < 0 || !Number.isInteger(output) || output < 0) throw problem('USAGE_UNAVAILABLE', 'provider response did not include trustworthy integer token usage', 502);
  const total = usage?.total_tokens;
  const totalTokens = Number.isInteger(total) && total >= 0 ? total : input + output;
  return { inputTokens: input, outputTokens: output, totalTokens, rawUsage: { input_tokens: input, output_tokens: output, total_tokens: totalTokens } };
}

export function extractOpenAICompatibleOutput(payload) {
  const content = payload?.choices?.[0]?.message?.content ?? payload?.output_text;
  if (typeof content !== 'string') throw problem('INVALID_PROVIDER_RESPONSE', 'provider response did not contain text output', 502);
  return content;
}

async function assertSystem(client, worldId, actorEntityId) {
  const actor = await resolveActor(client, actorEntityId);
  if (actor.world_id !== worldId) throw problem('WORLD_MISMATCH', 'actor belongs to a different world', 403);
  if (actor.entity_type !== 'SYSTEM') throw problem('FORBIDDEN', 'gateway configuration requires SYSTEM actor', 403);
  return actor;
}

export async function registerDescriptor(client, input) {
  const { worldId, actorEntityId } = input;
  await assertSystem(client, worldId, actorEntityId);
  const maxInputTokens = parsePositiveInt(input.maxInputTokens, 'maxInputTokens');
  const maxOutputTokens = parsePositiveInt(input.maxOutputTokens, 'maxOutputTokens');
  const timeoutMs = input.timeoutMs ?? 30_000;
  const maxAttempts = input.maxAttempts ?? 1;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw problem('INVALID_GATEWAY_INPUT', 'timeoutMs must be 100..300000');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw problem('INVALID_GATEWAY_INPUT', 'maxAttempts must be 1..3');
  const inputRate = parseNonNegativeMicroE(input.inputRateMicroEPerMillion ?? '0', 'inputRateMicroEPerMillion');
  const outputRate = parseNonNegativeMicroE(input.outputRateMicroEPerMillion ?? '0', 'outputRateMicroEPerMillion');
  if (!input.descriptorKey || !input.modelReference) throw problem('INVALID_GATEWAY_INPUT', 'descriptorKey and modelReference are required');
  const result = await client.query(
    `INSERT INTO gateway.capability_descriptors
      (world_id,descriptor_key,version,capability_type,provider_protocol,model_reference,assurance_level,verification_status,max_input_tokens,max_output_tokens,timeout_ms,max_attempts,supports_idempotency,supports_reconciliation,input_rate_micro_e_per_million,output_rate_micro_e_per_million,created_by)
     VALUES ($1,$2,$3,'MODEL_INFERENCE','OPENAI_COMPATIBLE',$4,$5,'UNVERIFIED',$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING descriptor_id,world_id,descriptor_key,version,capability_type,provider_protocol,model_reference,assurance_level,verification_status,status,max_input_tokens,max_output_tokens,timeout_ms,max_attempts,supports_idempotency,supports_reconciliation,input_rate_micro_e_per_million,output_rate_micro_e_per_million,created_at`,
    [worldId,input.descriptorKey,input.version ?? 1,input.modelReference,input.assuranceLevel ?? 'UNVERIFIED',maxInputTokens,maxOutputTokens,timeoutMs,maxAttempts,Boolean(input.supportsIdempotency),Boolean(input.supportsReconciliation),inputRate.toString(),outputRate.toString(),actorEntityId],
  );
  const descriptor = result.rows[0];
  if (input.actionId) await appendEvent(client,{worldId,aggregateType:'GATEWAY_DESCRIPTOR',aggregateId:descriptor.descriptor_id,eventType:'DESCRIPTOR_REGISTERED',actorEntityId,actionId:input.actionId,payload:{descriptorKey:descriptor.descriptor_key,version:descriptor.version,modelReference:descriptor.model_reference,verificationStatus:descriptor.verification_status}});
  return descriptor;
}

export async function registerConnector(client, input) {
  const { worldId, actorEntityId } = input;
  await assertSystem(client, worldId, actorEntityId);
  const connectorKind = input.connectorKind;
  const billingMode = input.billingMode;
  if (!['PLATFORM_PREPAID', 'BYOK'].includes(billingMode)) throw problem('INVALID_BILLING_MODE', 'billingMode must be PLATFORM_PREPAID or BYOK');
  const baseUrl = validateConnectorBaseUrl(input.baseUrl, connectorKind);
  const descriptor = await client.query(`SELECT descriptor_id,status FROM gateway.capability_descriptors WHERE world_id=$1 AND descriptor_id=$2`, [worldId, input.descriptorId]);
  if (descriptor.rowCount !== 1 || descriptor.rows[0].status !== 'ACTIVE') throw problem('DESCRIPTOR_NOT_AVAILABLE', 'descriptor is missing or disabled', 409);
  let credentialRefId = null;
  if (input.credentialEnvKey) {
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(input.credentialEnvKey)) throw problem('INVALID_CREDENTIAL_REF', 'credentialEnvKey must be an environment variable name');
    const credential = await client.query(
      `INSERT INTO gateway.credential_refs (world_id,env_key,created_by) VALUES ($1,$2,$3)
       ON CONFLICT (world_id,env_key) DO UPDATE SET env_key=EXCLUDED.env_key
       RETURNING credential_ref_id`,
      [worldId,input.credentialEnvKey,actorEntityId],
    );
    credentialRefId = credential.rows[0].credential_ref_id;
  }
  const result = await client.query(
    `INSERT INTO gateway.connector_configs (world_id,descriptor_id,connector_kind,billing_mode,base_url,credential_ref_id,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING connector_id,world_id,descriptor_id,connector_kind,billing_mode,base_url,credential_ref_id,enabled,created_at`,
    [worldId,input.descriptorId,connectorKind,billingMode,baseUrl,credentialRefId,actorEntityId],
  );
  const connector = result.rows[0];
  if (input.actionId) await appendEvent(client,{worldId,aggregateType:'GATEWAY_CONNECTOR',aggregateId:connector.connector_id,eventType:'CONNECTOR_REGISTERED',actorEntityId,actionId:input.actionId,payload:{descriptorId:input.descriptorId,connectorKind,billingMode}});
  return connector;
}

export async function listDescriptors(pool, { worldId, actorEntityId }) {
  return withTransaction(pool, async (client) => {
    const actor = await resolveActor(client, actorEntityId);
    if (actor.world_id !== worldId) throw problem('WORLD_MISMATCH', 'actor belongs to a different world', 403);
    const result = await client.query(
      `SELECT d.descriptor_id,d.descriptor_key,d.version,d.model_reference,d.assurance_level,d.verification_status,d.status,d.max_input_tokens,d.max_output_tokens,d.timeout_ms,d.max_attempts,d.supports_idempotency,d.supports_reconciliation,d.input_rate_micro_e_per_million,d.output_rate_micro_e_per_million,
              COALESCE(json_agg(json_build_object('connectorId',c.connector_id,'kind',c.connector_kind,'billingMode',c.billing_mode,'enabled',c.enabled)) FILTER (WHERE c.connector_id IS NOT NULL),'[]'::json) AS connectors
         FROM gateway.capability_descriptors d
         LEFT JOIN gateway.connector_configs c ON c.world_id=d.world_id AND c.descriptor_id=d.descriptor_id
        WHERE d.world_id=$1
        GROUP BY d.descriptor_id
        ORDER BY d.created_at`,
      [worldId],
    );
    return result.rows;
  });
}

async function loadExecutionPlan(client, { worldId, descriptorId, connectorId }) {
  const result = await client.query(
    `SELECT d.descriptor_id,d.model_reference,d.status AS descriptor_status,d.max_input_tokens,d.max_output_tokens,d.timeout_ms,d.max_attempts,d.supports_idempotency,d.supports_reconciliation,d.input_rate_micro_e_per_million,d.output_rate_micro_e_per_million,
            c.connector_id,c.connector_kind,c.billing_mode,c.base_url,c.enabled,c.credential_ref_id,cr.env_key AS credential_env_key
       FROM gateway.capability_descriptors d
       JOIN gateway.connector_configs c ON c.world_id=d.world_id AND c.descriptor_id=d.descriptor_id
       LEFT JOIN gateway.credential_refs cr ON cr.world_id=c.world_id AND cr.credential_ref_id=c.credential_ref_id
      WHERE d.world_id=$1 AND d.descriptor_id=$2 AND c.connector_id=$3`,
    [worldId,descriptorId,connectorId],
  );
  if (result.rowCount !== 1 || result.rows[0].descriptor_status !== 'ACTIVE' || !result.rows[0].enabled) throw problem('GATEWAY_NOT_AVAILABLE', 'descriptor or connector is missing/disabled', 409);
  return result.rows[0];
}

async function prepareExecution(pool, input) {
  return withTransaction(pool, async (client) => {
    const actor = await resolveActor(client, input.actorEntityId);
    if (actor.world_id !== input.worldId) throw problem('WORLD_MISMATCH', 'actor belongs to a different world', 403);
    if (input.activitySubjectId !== input.actorEntityId || input.payerEntityId !== input.actorEntityId) throw problem('FORBIDDEN', 'P1.3 inference requires actor=activity subject=payer until delegation is implemented', 403);
    const payloadHash = hashPayload(input.actionPayload);
    const inserted = await client.query(
      `INSERT INTO core.actions (world_id,actor_entity_id,action_type,idempotency_key,payload_hash,status)
       VALUES ($1,$2,'gateway.infer',$3,$4,'PENDING')
       ON CONFLICT (world_id,actor_entity_id,idempotency_key) DO NOTHING RETURNING action_id`,
      [input.worldId,input.actorEntityId,input.idempotencyKey,payloadHash],
    );
    if (inserted.rowCount === 0) {
      const prior = await client.query(
        `SELECT a.action_id,a.action_type,a.payload_hash,a.status,a.result_json,a.error_code,e.execution_id
           FROM core.actions a LEFT JOIN gateway.executions e ON e.world_id=a.world_id AND e.action_id=a.action_id
          WHERE a.world_id=$1 AND a.actor_entity_id=$2 AND a.idempotency_key=$3 FOR UPDATE OF a`,
        [input.worldId,input.actorEntityId,input.idempotencyKey],
      );
      const row = prior.rows[0];
      if (row.action_type !== 'gateway.infer' || row.payload_hash !== payloadHash) throw problem('IDEMPOTENCY_CONFLICT', 'same idempotency key used with different inference command', 409);
      if (['PENDING','DISPATCHED'].includes(row.status)) throw problem('EXECUTION_IN_PROGRESS', 'matching inference is already in progress', 409);
      return { replayed: true, actionId: row.action_id, executionId: row.execution_id, status: row.status, result: row.result_json, errorCode: row.error_code };
    }
    const actionId = inserted.rows[0].action_id;
    const plan = await loadExecutionPlan(client, input);
    const messages = normalizeMessages(input.messages);
    const inputTokenUpperBound = conservativeInputTokenUpperBound(messages);
    if (inputTokenUpperBound > Number(plan.max_input_tokens)) throw problem('MODEL_INPUT_LIMIT_EXCEEDED', `input conservative token bound ${inputTokenUpperBound} exceeds descriptor max_input_tokens ${plan.max_input_tokens}`, 409);
    const maxOutputTokens = input.maxOutputTokens ?? Number(plan.max_output_tokens);
    parsePositiveInt(maxOutputTokens, 'maxOutputTokens');
    if (maxOutputTokens > Number(plan.max_output_tokens)) throw problem('MODEL_LIMIT_EXCEEDED', 'maxOutputTokens exceeds descriptor limit', 409);
    const maxCharge = parseNonNegativeMicroE(input.maxChargeMicroE, 'maxChargeMicroE');
    if (plan.billing_mode === 'PLATFORM_PREPAID') {
      const conservativeMaxCharge = calculateUsageCharge({inputTokens:inputTokenUpperBound,outputTokens:maxOutputTokens,inputRateMicroEPerMillion:plan.input_rate_micro_e_per_million,outputRateMicroEPerMillion:plan.output_rate_micro_e_per_million});
      if (maxCharge < conservativeMaxCharge) throw problem('AUTHORIZATION_TOO_SMALL', `maxChargeMicroE must cover the conservative request bound of ${conservativeMaxCharge}`, 409);
    }
    const fee = await client.query(`SELECT status FROM economy.activity_fees WHERE world_id=$1 AND activity_subject_id=$2 AND billing_date=$3`, [input.worldId,input.activitySubjectId,input.billingDate]);
    if (fee.rowCount !== 1 || fee.rows[0].status !== 'CHARGED') throw problem('DAILY_FEE_REQUIRED', 'a charged activity fee for this billing date is required before inference', 409);
    if (plan.billing_mode === 'PLATFORM_PREPAID') {
      if (!input.reservationId) throw problem('RESERVATION_REQUIRED', 'platform-paid inference requires a reservation', 409);
      const reservation = await client.query(`SELECT entity_id,amount_micro_e,status FROM economy.reservations WHERE world_id=$1 AND reservation_id=$2 FOR UPDATE`, [input.worldId,input.reservationId]);
      if (reservation.rowCount !== 1 || reservation.rows[0].entity_id !== input.payerEntityId || reservation.rows[0].status !== 'ACTIVE') throw problem('INVALID_RESERVATION', 'reservation is missing, not active or owned by another payer', 409);
      if (BigInt(reservation.rows[0].amount_micro_e) < maxCharge) throw problem('RESERVATION_TOO_SMALL', 'reservation does not cover maxChargeMicroE', 409);
    } else if (input.reservationId) {
      throw problem('BYOK_RESERVATION_NOT_ALLOWED', 'BYOK inference must not reserve platform Energy for the external model charge', 409);
    }
    const execution = await client.query(
      `INSERT INTO gateway.executions (world_id,action_id,activity_subject_id,payer_entity_id,descriptor_id,connector_id,reservation_id,billing_date,action_purpose,input_digest,max_charge_micro_e,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PROPOSED') RETURNING execution_id`,
      [input.worldId,actionId,input.activitySubjectId,input.payerEntityId,input.descriptorId,input.connectorId,input.reservationId ?? null,input.billingDate,input.actionPurpose,hashPayload({messages,maxOutputTokens}),maxCharge.toString()],
    );
    const executionId = execution.rows[0].execution_id;
    await appendEvent(client,{worldId:input.worldId,aggregateType:'GATEWAY_EXECUTION',aggregateId:executionId,eventType:'EXECUTION_PROPOSED',actorEntityId:input.actorEntityId,actionId,payload:{descriptorId:input.descriptorId,connectorId:input.connectorId,billingDate:input.billingDate,actionPurpose:input.actionPurpose,inputTokenUpperBound}});
    return { replayed:false, actionId, executionId, plan, messages, maxOutputTokens, maxCharge, inputTokenUpperBound };
  });
}

async function assertDispatchEligibility(client, prepared, currentBillingDate) {
  const actor = await resolveActor(client, prepared.actorEntityId);
  if (actor.world_id !== prepared.worldId) throw problem('WORLD_MISMATCH', 'actor belongs to a different world', 403);
  if (prepared.billingDate !== currentBillingDate) throw problem('STALE_ACTIVITY_TICKET', `billing date ${prepared.billingDate} is not current UTC date ${currentBillingDate}`, 409);
  const fee = await client.query(`SELECT status FROM economy.activity_fees WHERE world_id=$1 AND activity_subject_id=$2 AND billing_date=$3`, [prepared.worldId,prepared.activitySubjectId,prepared.billingDate]);
  if (fee.rowCount !== 1 || fee.rows[0].status !== 'CHARGED') throw problem('DAILY_FEE_REQUIRED', 'current activity fee is not charged', 409);
  const wallet = await client.query(`SELECT available_micro_e FROM economy.wallet_balances WHERE world_id=$1 AND entity_id=$2`, [prepared.worldId,prepared.activitySubjectId]);
  if (wallet.rowCount !== 1 || BigInt(wallet.rows[0].available_micro_e) <= 0n) throw problem('NO_AVAILABLE_ENERGY', 'activity subject has no positive available Energy', 409);
  const route = await client.query(
    `SELECT d.status AS descriptor_status,c.enabled,c.descriptor_id
       FROM gateway.capability_descriptors d
       JOIN gateway.connector_configs c ON c.world_id=d.world_id AND c.descriptor_id=d.descriptor_id
      WHERE d.world_id=$1 AND d.descriptor_id=$2 AND c.connector_id=$3`,
    [prepared.worldId,prepared.descriptorId,prepared.connectorId],
  );
  if (route.rowCount !== 1 || route.rows[0].descriptor_status !== 'ACTIVE' || !route.rows[0].enabled || route.rows[0].descriptor_id !== prepared.descriptorId) throw problem('GATEWAY_NOT_AVAILABLE', 'descriptor or connector is no longer active', 409);
  if (prepared.plan.billing_mode === 'PLATFORM_PREPAID') {
    const reservation = await client.query(`SELECT entity_id,amount_micro_e,status FROM economy.reservations WHERE world_id=$1 AND reservation_id=$2 FOR UPDATE`, [prepared.worldId,prepared.reservationId]);
    if (reservation.rowCount !== 1 || reservation.rows[0].entity_id !== prepared.payerEntityId || reservation.rows[0].status !== 'ACTIVE') throw problem('INVALID_RESERVATION', 'reservation is no longer active for this payer', 409);
    if (BigInt(reservation.rows[0].amount_micro_e) < prepared.maxCharge) throw problem('RESERVATION_TOO_SMALL', 'reservation no longer covers authorization', 409);
  }
}

async function markAttemptDispatched(pool, prepared, attemptNo, currentBillingDate) {
  return withTransaction(pool, async (client) => {
    const current = await client.query(`SELECT status FROM gateway.executions WHERE world_id=$1 AND execution_id=$2 FOR UPDATE`, [prepared.worldId,prepared.executionId]);
    if (!current.rowCount || !['PROPOSED','DISPATCHED'].includes(current.rows[0].status)) throw problem('EXECUTION_NOT_DISPATCHABLE', 'execution cannot be dispatched', 409);
    await assertDispatchEligibility(client, prepared, currentBillingDate);
    const attempt = await client.query(
      `INSERT INTO gateway.execution_attempts (world_id,execution_id,attempt_no,status) VALUES ($1,$2,$3,'STARTED') RETURNING attempt_id`,
      [prepared.worldId,prepared.executionId,attemptNo],
    );
    const attemptId = attempt.rows[0].attempt_id;
    const providerIdempotencyKey = `nh-${prepared.executionId}`;
    const requestDigest = hashPayload(prepared.providerBody);
    await client.query(
      `INSERT INTO gateway.provider_requests (world_id,execution_id,attempt_id,request_digest,provider_idempotency_key,status) VALUES ($1,$2,$3,$4,$5,'DISPATCHED')`,
      [prepared.worldId,prepared.executionId,attemptId,requestDigest,providerIdempotencyKey],
    );
    await client.query(`UPDATE gateway.executions SET status='DISPATCHED' WHERE world_id=$1 AND execution_id=$2`, [prepared.worldId,prepared.executionId]);
    await client.query(`UPDATE core.actions SET status='DISPATCHED' WHERE world_id=$1 AND action_id=$2`, [prepared.worldId,prepared.actionId]);
    await appendEvent(client,{worldId:prepared.worldId,aggregateType:'GATEWAY_EXECUTION',aggregateId:prepared.executionId,eventType:'EXECUTION_DISPATCHED',actorEntityId:prepared.actorEntityId,actionId:prepared.actionId,payload:{attemptNo,billingDate:prepared.billingDate}});
    return { attemptId, providerIdempotencyKey };
  });
}

async function markRetryableFailure(pool, prepared, attempt, httpStatus, errorClass) {
  return withTransaction(pool, async (client) => {
    await client.query(`UPDATE gateway.execution_attempts SET status='FAILED',http_status=$3,error_class=$4,completed_at=now() WHERE world_id=$1 AND attempt_id=$2`, [prepared.worldId,attempt.attemptId,httpStatus,errorClass]);
    await client.query(`UPDATE gateway.provider_requests SET status='FAILED',completed_at=now() WHERE world_id=$1 AND attempt_id=$2`, [prepared.worldId,attempt.attemptId]);
  });
}

async function writeReceipt(client, prepared, attempt, usage, charge, providerRequestId, externalBilling) {
  return client.query(
    `INSERT INTO gateway.usage_receipts (world_id,execution_id,attempt_id,provider_request_id,input_tokens,output_tokens,total_tokens,charge_micro_e,external_billing,status,raw_usage)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'FINAL',$10::jsonb) RETURNING receipt_id`,
    [prepared.worldId,prepared.executionId,attempt.attemptId,providerRequestId ?? null,usage.inputTokens,usage.outputTokens,usage.totalTokens,charge.toString(),externalBilling,JSON.stringify(usage.rawUsage)],
  );
}

async function finalizeSuccess(pool, prepared, attempt, { output, usage, providerRequestId }) {
  return withTransaction(pool, async (client) => {
    const charge = prepared.plan.billing_mode === 'BYOK' ? 0n : calculateUsageCharge({inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,inputRateMicroEPerMillion:prepared.plan.input_rate_micro_e_per_million,outputRateMicroEPerMillion:prepared.plan.output_rate_micro_e_per_million});
    if (charge > prepared.maxCharge) throw problem('MEASURED_USAGE_EXCEEDS_AUTHORIZATION', 'measured usage exceeds maxChargeMicroE; reconciliation required', 409);
    let settlement = null;
    if (prepared.plan.billing_mode === 'PLATFORM_PREPAID') {
      settlement = await settleReservation(client,{worldId:prepared.worldId,entityId:prepared.payerEntityId,reservationId:prepared.reservationId,actualAmountMicroE:charge.toString(),businessKey:`gateway:${prepared.executionId}`,actorEntityId:prepared.actorEntityId,actionId:prepared.actionId});
    }
    const receipt = await writeReceipt(client,prepared,attempt,usage,charge,providerRequestId,prepared.plan.billing_mode === 'BYOK');
    await client.query(`UPDATE gateway.execution_attempts SET status='SUCCEEDED',http_status=200,completed_at=now() WHERE world_id=$1 AND attempt_id=$2`, [prepared.worldId,attempt.attemptId]);
    await client.query(`UPDATE gateway.provider_requests SET status='SUCCEEDED',provider_request_id=$3,completed_at=now() WHERE world_id=$1 AND attempt_id=$2`, [prepared.worldId,attempt.attemptId,providerRequestId ?? null]);
    const result = { executionId:prepared.executionId,status:'SUCCEEDED',output,usage:{inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,totalTokens:usage.totalTokens},chargeMicroE:charge.toString(),externalBilling:prepared.plan.billing_mode === 'BYOK',receiptId:receipt.rows[0].receipt_id,settlementJournalId:settlement?.journalId ?? null,providerRequestId:providerRequestId ?? null,modelReference:prepared.plan.model_reference };
    await client.query(`UPDATE gateway.executions SET status='SUCCEEDED',final_charge_micro_e=$3,provider_request_id=$4,result_json=$5::jsonb,completed_at=now() WHERE world_id=$1 AND execution_id=$2`, [prepared.worldId,prepared.executionId,charge.toString(),providerRequestId ?? null,JSON.stringify(result)]);
    await client.query(`UPDATE core.actions SET status='SUCCEEDED',result_json=$3::jsonb,completed_at=now() WHERE world_id=$1 AND action_id=$2`, [prepared.worldId,prepared.actionId,JSON.stringify(result)]);
    await appendEvent(client,{worldId:prepared.worldId,aggregateType:'GATEWAY_EXECUTION',aggregateId:prepared.executionId,eventType:'EXECUTION_SUCCEEDED',actorEntityId:prepared.actorEntityId,actionId:prepared.actionId,payload:{receiptId:receipt.rows[0].receipt_id,chargeMicroE:charge.toString(),providerRequestId:providerRequestId ?? null}});
    await appendEvent(client,{worldId:prepared.worldId,aggregateType:'ACTION',aggregateId:prepared.actionId,eventType:'ACTION_SUCCEEDED',actorEntityId:prepared.actorEntityId,actionId:prepared.actionId,payload:{actionType:'gateway.infer'}});
    return result;
  });
}

async function finalizeEligibilityFailure(pool, prepared, { code, message, dispatchedBefore = false }) {
  return withTransaction(pool, async (client) => {
    if (prepared.plan.billing_mode === 'PLATFORM_PREPAID' && prepared.reservationId) {
      const reservation = await client.query(`SELECT status FROM economy.reservations WHERE world_id=$1 AND entity_id=$2 AND reservation_id=$3`, [prepared.worldId,prepared.payerEntityId,prepared.reservationId]);
      if (reservation.rows[0]?.status === 'ACTIVE') await releaseReservation(client,{worldId:prepared.worldId,entityId:prepared.payerEntityId,reservationId:prepared.reservationId,actorEntityId:prepared.actorEntityId,actionId:prepared.actionId});
    }
    const result = {executionId:prepared.executionId,status:'FAILED',error:code,message,dispatchedBefore};
    await client.query(`UPDATE gateway.executions SET status='FAILED',error_code=$3,result_json=$4::jsonb,completed_at=now() WHERE world_id=$1 AND execution_id=$2`, [prepared.worldId,prepared.executionId,code,JSON.stringify(result)]);
    await client.query(`UPDATE core.actions SET status='FAILED',error_code=$3,result_json=$4::jsonb,completed_at=now() WHERE world_id=$1 AND action_id=$2`, [prepared.worldId,prepared.actionId,code,JSON.stringify(result)]);
    await appendEvent(client,{worldId:prepared.worldId,aggregateType:'GATEWAY_EXECUTION',aggregateId:prepared.executionId,eventType:'EXECUTION_FAILED',actorEntityId:prepared.actorEntityId,actionId:prepared.actionId,payload:{errorCode:code,dispatchedBefore}});
    await appendEvent(client,{worldId:prepared.worldId,aggregateType:'ACTION',aggregateId:prepared.actionId,eventType:'ACTION_FAILED',actorEntityId:prepared.actorEntityId,actionId:prepared.actionId,payload:{actionType:'gateway.infer',errorCode:code}});
    return result;
  });
}

async function finalizePreDispatchFailure(pool, prepared, input) {
  return finalizeEligibilityFailure(pool,prepared,{...input,dispatchedBefore:false});
}

async function finalizeFailure(pool, prepared, attempt, { code, message, httpStatus = null, providerRequestId = null, usage = null }) {
  return withTransaction(pool, async (client) => {
    let charge = 0n; let receiptId = null; let settlementJournalId = null;
    if (usage) {
      charge = prepared.plan.billing_mode === 'BYOK' ? 0n : calculateUsageCharge({inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,inputRateMicroEPerMillion:prepared.plan.input_rate_micro_e_per_million,outputRateMicroEPerMillion:prepared.plan.output_rate_micro_e_per_million});
      if (charge > prepared.maxCharge) throw problem('MEASURED_USAGE_EXCEEDS_AUTHORIZATION','provider response reported usage above the authorized maximum',409);
      if (prepared.plan.billing_mode === 'PLATFORM_PREPAID') {
        const settlement = await settleReservation(client,{worldId:prepared.worldId,entityId:prepared.payerEntityId,reservationId:prepared.reservationId,actualAmountMicroE:charge.toString(),businessKey:`gateway:${prepared.executionId}`,actorEntityId:prepared.actorEntityId,actionId:prepared.actionId});
        settlementJournalId = settlement.journalId;
      }
      const receipt = await writeReceipt(client,prepared,attempt,usage,charge,providerRequestId,prepared.plan.billing_mode === 'BYOK'); receiptId = receipt.rows[0].receipt_id;
    } else if (prepared.plan.billing_mode === 'PLATFORM_PREPAID' && prepared.reservationId) {
      await releaseReservation(client,{worldId:prepared.worldId,entityId:prepared.payerEntityId,reservationId:prepared.reservationId,actorEntityId:prepared.actorEntityId,actionId:prepared.actionId});
    }
    await client.query(`UPDATE gateway.execution_attempts SET status='FAILED',http_status=$3,error_class=$4,completed_at=now() WHERE world_id=$1 AND attempt_id=$2`, [prepared.worldId,attempt.attemptId,httpStatus,code]);
    await client.query(`UPDATE gateway.provider_requests SET status='FAILED',provider_request_id=$3,completed_at=now() WHERE world_id=$1 AND attempt_id=$2`, [prepared.worldId,attempt.attemptId,providerRequestId]);
    const result = {executionId:prepared.executionId,status:'FAILED',error:code,message,chargeMicroE:charge.toString(),receiptId,settlementJournalId};
    await client.query(`UPDATE gateway.executions SET status='FAILED',final_charge_micro_e=$3,error_code=$4,result_json=$5::jsonb,completed_at=now() WHERE world_id=$1 AND execution_id=$2`, [prepared.worldId,prepared.executionId,charge.toString(),code,JSON.stringify(result)]);
    await client.query(`UPDATE core.actions SET status='FAILED',error_code=$3,result_json=$4::jsonb,completed_at=now() WHERE world_id=$1 AND action_id=$2`, [prepared.worldId,prepared.actionId,code,JSON.stringify(result)]);
    await appendEvent(client,{worldId:prepared.worldId,aggregateType:'GATEWAY_EXECUTION',aggregateId:prepared.executionId,eventType:'EXECUTION_FAILED',actorEntityId:prepared.actorEntityId,actionId:prepared.actionId,payload:{errorCode:code,httpStatus,chargeMicroE:charge.toString(),receiptId}});
    await appendEvent(client,{worldId:prepared.worldId,aggregateType:'ACTION',aggregateId:prepared.actionId,eventType:'ACTION_FAILED',actorEntityId:prepared.actorEntityId,actionId:prepared.actionId,payload:{actionType:'gateway.infer',errorCode:code}});
    return result;
  });
}

async function finalizeUnknown(pool, prepared, attempt, { code, message }) {
  return withTransaction(pool, async (client) => {
    await client.query(`UPDATE gateway.execution_attempts SET status='OUTCOME_UNKNOWN',error_class=$3,completed_at=now() WHERE world_id=$1 AND attempt_id=$2`, [prepared.worldId,attempt.attemptId,code]);
    await client.query(`UPDATE gateway.provider_requests SET status='OUTCOME_UNKNOWN',completed_at=now() WHERE world_id=$1 AND attempt_id=$2`, [prepared.worldId,attempt.attemptId]);
    const result = {executionId:prepared.executionId,status:'OUTCOME_UNKNOWN',error:code,message,reconciliationRequired:true};
    await client.query(`UPDATE gateway.executions SET status='OUTCOME_UNKNOWN',error_code=$3,result_json=$4::jsonb,completed_at=now() WHERE world_id=$1 AND execution_id=$2`, [prepared.worldId,prepared.executionId,code,JSON.stringify(result)]);
    await client.query(`UPDATE core.actions SET status='OUTCOME_UNKNOWN',error_code=$3,result_json=$4::jsonb,completed_at=now() WHERE world_id=$1 AND action_id=$2`, [prepared.worldId,prepared.actionId,code,JSON.stringify(result)]);
    await client.query(`INSERT INTO gateway.reconciliation_jobs (world_id,execution_id,reason,status) VALUES ($1,$2,$3,'PENDING') ON CONFLICT (world_id,execution_id) DO NOTHING`, [prepared.worldId,prepared.executionId,code]);
    await appendEvent(client,{worldId:prepared.worldId,aggregateType:'GATEWAY_EXECUTION',aggregateId:prepared.executionId,eventType:'EXECUTION_OUTCOME_UNKNOWN',actorEntityId:prepared.actorEntityId,actionId:prepared.actionId,payload:{errorCode:code,reconciliationRequired:true}});
    return result;
  });
}

function retryDelayMs(response, attemptNo) {
  const header = response.headers.get('retry-after');
  if (header && /^\d+$/.test(header)) return Math.min(Number(header) * 1000, 30_000);
  return Math.min(100 * 2 ** (attemptNo - 1), 2_000);
}

function currentUtcDate(nowValue) {
  const date = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (Number.isNaN(date.getTime())) throw problem('INVALID_CLOCK','clock returned an invalid date',500);
  return date.toISOString().slice(0,10);
}

function usageChargeForPrepared(prepared, usage) {
  return prepared.plan.billing_mode === 'BYOK' ? 0n : calculateUsageCharge({inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,inputRateMicroEPerMillion:prepared.plan.input_rate_micro_e_per_million,outputRateMicroEPerMillion:prepared.plan.output_rate_micro_e_per_million});
}

function usageExceedsAuthorization(prepared, usage) {
  return usageChargeForPrepared(prepared,usage) > prepared.maxCharge;
}

export async function infer(pool, input, { fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  if (!input.idempotencyKey) throw problem('IDEMPOTENCY_KEY_REQUIRED', 'idempotency key is required');
  const actionPurpose = normalizeActionPurpose(input.actionPurpose);
  const temperature = normalizeTemperature(input.temperature);
  const actionPayload = {descriptorId:input.descriptorId,connectorId:input.connectorId,activitySubjectId:input.activitySubjectId,payerEntityId:input.payerEntityId,reservationId:input.reservationId ?? null,billingDate:input.billingDate,actionPurpose,messages:input.messages,maxOutputTokens:input.maxOutputTokens,maxChargeMicroE:input.maxChargeMicroE,temperature};
  const preparedBase = await prepareExecution(pool,{...input,actionPurpose,temperature,actionPayload});
  if (preparedBase.replayed) return preparedBase;
  const prepared = {...preparedBase,worldId:input.worldId,actorEntityId:input.actorEntityId,activitySubjectId:input.activitySubjectId,payerEntityId:input.payerEntityId,reservationId:input.reservationId ?? null,billingDate:input.billingDate,descriptorId:input.descriptorId,connectorId:input.connectorId,actionPurpose,providerBody:{model:preparedBase.plan.model_reference,messages:preparedBase.messages,max_tokens:preparedBase.maxOutputTokens,...(temperature === null ? {} : {temperature})}};
  const endpoint = new URL('v1/chat/completions', validateConnectorBaseUrl(prepared.plan.base_url, prepared.plan.connector_kind));
  const allowedAttempts = prepared.plan.supports_idempotency ? Number(prepared.plan.max_attempts) : 1;
  let attemptsDispatched = 0;
  for (let attemptNo = 1; attemptNo <= allowedAttempts; attemptNo += 1) {
    const secret = prepared.plan.credential_env_key ? process.env[prepared.plan.credential_env_key] : null;
    if (prepared.plan.credential_env_key && !secret) return finalizePreDispatchFailure(pool,prepared,{code:'CREDENTIAL_UNAVAILABLE',message:'configured credential environment variable is not available'});
    let attempt;
    try {
      attempt = await markAttemptDispatched(pool,prepared,attemptNo,currentUtcDate(now()));
    } catch (error) {
      if (DISPATCH_BLOCK_CODES.has(error?.code)) return finalizeEligibilityFailure(pool,prepared,{code:error.code,message:error.message,dispatchedBefore:attemptsDispatched > 0});
      throw error;
    }
    attemptsDispatched += 1;
    const headers = {'content-type':'application/json'};
    if (secret) headers.authorization = `Bearer ${secret}`;
    if (prepared.plan.supports_idempotency) headers['idempotency-key'] = attempt.providerIdempotencyKey;
    let response;
    try {
      response = await fetchImpl(endpoint,{method:'POST',headers,body:JSON.stringify(prepared.providerBody),redirect:'manual',signal:AbortSignal.timeout(Number(prepared.plan.timeout_ms))});
    } catch (error) {
      const code = error?.cause?.code;
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (timedOut || !CONFIRMED_CONNECT_FAILURES.has(code)) return finalizeUnknown(pool,prepared,attempt,{code:'PROVIDER_OUTCOME_UNKNOWN',message:'provider request ended without a trustworthy execution outcome'});
      if (attemptNo < allowedAttempts) { await markRetryableFailure(pool,prepared,attempt,null,code || 'CONNECT_FAILED'); await sleep(Math.min(100 * attemptNo,500)); continue; }
      return finalizeFailure(pool,prepared,attempt,{code:'PROVIDER_CONNECT_FAILED',message:'provider connection failed before a response'});
    }
    let payload = {};
    try { payload = await response.json(); } catch {}
    const providerRequestId = response.headers.get('x-request-id') ?? payload?.id ?? null;
    if (!response.ok) {
      let failureUsage = null;
      try { failureUsage = extractOpenAICompatibleUsage(payload); } catch {}
      if (failureUsage && prepared.plan.billing_mode === 'PLATFORM_PREPAID' && usageExceedsAuthorization(prepared,failureUsage)) {
        return finalizeUnknown(pool,prepared,attempt,{code:'MEASURED_USAGE_EXCEEDS_AUTHORIZATION',message:'failed provider response reported usage above the authorized maximum'});
      }
      if (!failureUsage && RETRYABLE_HTTP.has(response.status) && prepared.plan.supports_idempotency && attemptNo < allowedAttempts) {
        await markRetryableFailure(pool,prepared,attempt,response.status,`HTTP_${response.status}`);
        await sleep(retryDelayMs(response,attemptNo));
        continue;
      }
      return finalizeFailure(pool,prepared,attempt,{code:`PROVIDER_HTTP_${response.status}`,message:'provider returned a confirmed error response',httpStatus:response.status,providerRequestId,usage:failureUsage});
    }
    let usage;
    try { usage = extractOpenAICompatibleUsage(payload); }
    catch (error) { return finalizeUnknown(pool,prepared,attempt,{code:error.code || 'USAGE_UNAVAILABLE',message:error.message}); }
    if (usageExceedsAuthorization(prepared,usage)) return finalizeUnknown(pool,prepared,attempt,{code:'MEASURED_USAGE_EXCEEDS_AUTHORIZATION',message:'provider usage exceeds authorized maximum; reservation retained for reconciliation'});
    if (usage.inputTokens > Number(prepared.plan.max_input_tokens)) {
      return finalizeFailure(pool,prepared,attempt,{code:'PROVIDER_INPUT_LIMIT_EXCEEDED',message:'provider reported input usage above the descriptor limit',httpStatus:response.status,providerRequestId,usage});
    }
    if (usage.outputTokens > prepared.maxOutputTokens) {
      return finalizeFailure(pool,prepared,attempt,{code:'PROVIDER_OUTPUT_LIMIT_EXCEEDED',message:'provider reported output usage above the requested maximum',httpStatus:response.status,providerRequestId,usage});
    }
    let output;
    try { output = extractOpenAICompatibleOutput(payload); }
    catch (error) {
      return finalizeFailure(pool,prepared,attempt,{code:error.code || 'INVALID_PROVIDER_RESPONSE',message:error.message,httpStatus:response.status,providerRequestId,usage});
    }
    return finalizeSuccess(pool,prepared,attempt,{output,usage,providerRequestId});
  }
  throw problem('GATEWAY_INTERNAL_ERROR','attempt loop exhausted',500);
}

export async function inspectExecution(pool, { worldId, executionId, actorEntityId }) {
  return withTransaction(pool, async (client) => {
    const actor = await resolveActor(client,actorEntityId);
    if (actor.world_id !== worldId) throw problem('WORLD_MISMATCH','actor belongs to a different world',403);
    const execution = await client.query(`SELECT * FROM gateway.executions WHERE world_id=$1 AND execution_id=$2`,[worldId,executionId]);
    if (execution.rowCount !== 1) throw problem('EXECUTION_NOT_FOUND','execution not found',404);
    const row = execution.rows[0];
    if (actor.entity_type !== 'SYSTEM' && actor.entity_id !== row.activity_subject_id && actor.entity_id !== row.payer_entity_id) throw problem('FORBIDDEN','execution is not visible to this actor',403);
    const attempts = await client.query(`SELECT attempt_id,attempt_no,status,http_status,error_class,started_at,completed_at FROM gateway.execution_attempts WHERE world_id=$1 AND execution_id=$2 ORDER BY attempt_no`,[worldId,executionId]);
    const receipts = await client.query(`SELECT receipt_id,input_tokens,output_tokens,total_tokens,charge_micro_e,external_billing,status,provider_request_id,created_at FROM gateway.usage_receipts WHERE world_id=$1 AND execution_id=$2 ORDER BY created_at`,[worldId,executionId]);
    const reconciliation = await client.query(`SELECT reconciliation_id,reason,status,created_at,resolved_at FROM gateway.reconciliation_jobs WHERE world_id=$1 AND execution_id=$2`,[worldId,executionId]);
    return {execution:row,attempts:attempts.rows,receipts:receipts.rows,reconciliation:reconciliation.rows[0] ?? null};
  });
}
