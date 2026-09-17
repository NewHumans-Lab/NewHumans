import { withTransaction } from '../db.js';
import { appendEvent, resolveActor } from './core.js';
import { reserve, releaseReservation } from './economy.js';
import { calculateUsageCharge, conservativeInputTokenUpperBound, infer, registerConnector, validateConnectorBaseUrl } from './gateway.js';

function problem(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function positiveInt(value, field) { if (!Number.isInteger(value) || value <= 0) throw problem('INVALID_QUOTE_INPUT', `${field} must be a positive integer`); return value; }
function retries(value) { const v=value ?? 0; if(!Number.isInteger(v)||v<0||v>3)throw problem('INVALID_GATEWAY_INPUT','maxRetries must be 0..3'); return v; }
async function assertSystem(client,worldId,actorEntityId){const a=await resolveActor(client,actorEntityId);if(a.world_id!==worldId)throw problem('WORLD_MISMATCH','actor belongs to a different world',403);if(a.entity_type!=='SYSTEM')throw problem('FORBIDDEN','gateway configuration requires SYSTEM actor',403);return a;}

export async function registerDescriptorP14(client,input){
  await assertSystem(client,input.worldId,input.actorEntityId);
  const maxInputTokens=positiveInt(input.maxInputTokens,'maxInputTokens');
  const maxOutputTokens=positiveInt(input.maxOutputTokens,'maxOutputTokens');
  const maxRetries=retries(input.maxRetries);
  const timeoutMs=input.timeoutMs??30000;
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>300000)throw problem('INVALID_GATEWAY_INPUT','timeoutMs must be 100..300000');
  if(!input.descriptorKey||!input.modelReference)throw problem('INVALID_GATEWAY_INPUT','descriptorKey and modelReference are required');
  const inputRate=String(input.inputRateMicroEPerMillion??'0'),outputRate=String(input.outputRateMicroEPerMillion??'0');
  if(!/^\d+$/.test(inputRate)||!/^\d+$/.test(outputRate))throw problem('INVALID_AMOUNT','gateway rates must be non-negative decimal integer strings');
  const result=await client.query(`INSERT INTO gateway.capability_descriptors
    (world_id,descriptor_key,version,capability_type,provider_protocol,model_reference,assurance_level,verification_status,max_input_tokens,max_output_tokens,timeout_ms,max_attempts,max_retries,supports_idempotency,supports_reconciliation,input_rate_micro_e_per_million,output_rate_micro_e_per_million,created_by)
    VALUES ($1,$2,$3,'MODEL_INFERENCE','OPENAI_COMPATIBLE',$4,$5,'UNVERIFIED',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    RETURNING descriptor_id,world_id,descriptor_key,version,capability_type,provider_protocol,model_reference,assurance_level,verification_status,status,max_input_tokens,max_output_tokens,timeout_ms,max_retries,supports_idempotency,supports_reconciliation,input_rate_micro_e_per_million,output_rate_micro_e_per_million,created_at`,
    [input.worldId,input.descriptorKey,input.version??1,input.modelReference,input.assuranceLevel??'UNVERIFIED',maxInputTokens,maxOutputTokens,timeoutMs,maxRetries+1,maxRetries,Boolean(input.supportsIdempotency),Boolean(input.supportsReconciliation),inputRate,outputRate,input.actorEntityId]);
  const d=result.rows[0];
  if(input.actionId)await appendEvent(client,{worldId:input.worldId,aggregateType:'GATEWAY_DESCRIPTOR',aggregateId:d.descriptor_id,eventType:'DESCRIPTOR_REGISTERED',actorEntityId:input.actorEntityId,actionId:input.actionId,payload:{descriptorKey:d.descriptor_key,version:d.version,modelReference:d.model_reference,verificationStatus:d.verification_status,maxRetries:d.max_retries}});
  return d;
}

export async function registerConnectorP14(client,input){
  if(!input.replacesConnectorId)return registerConnector(client,input);
  await assertSystem(client,input.worldId,input.actorEntityId);
  const prior=(await client.query(`SELECT connector_id,descriptor_id,connector_kind,billing_mode,base_url,credential_ref_id,enabled
    FROM gateway.connector_configs WHERE world_id=$1 AND connector_id=$2 FOR UPDATE`,[input.worldId,input.replacesConnectorId])).rows[0];
  if(!prior)throw problem('CONNECTOR_NOT_FOUND','connector to replace was not found',404);
  if(!prior.enabled)throw problem('CONNECTOR_ALREADY_REPLACED','connector replacement source is already disabled',409);
  if(input.descriptorId&&input.descriptorId!==prior.descriptor_id)throw problem('CONNECTOR_REPLACEMENT_SCOPE_MISMATCH','replacement must keep the same descriptor',409);
  if(input.connectorKind&&input.connectorKind!==prior.connector_kind)throw problem('CONNECTOR_REPLACEMENT_SCOPE_MISMATCH','replacement must keep the same connector kind',409);
  if(input.billingMode&&input.billingMode!==prior.billing_mode)throw problem('CONNECTOR_REPLACEMENT_SCOPE_MISMATCH','credential rotation must not change billing mode',409);
  if(input.baseUrl&&validateConnectorBaseUrl(input.baseUrl,prior.connector_kind)!==prior.base_url)throw problem('CONNECTOR_REPLACEMENT_SCOPE_MISMATCH','credential rotation must keep the same endpoint',409);
  await client.query(`UPDATE gateway.connector_configs SET enabled=false WHERE world_id=$1 AND connector_id=$2`,[input.worldId,prior.connector_id]);
  const replacement=await registerConnector(client,{
    ...input,
    descriptorId:prior.descriptor_id,
    connectorKind:prior.connector_kind,
    billingMode:prior.billing_mode,
    baseUrl:prior.base_url,
  });
  if(input.actionId)await appendEvent(client,{worldId:input.worldId,aggregateType:'GATEWAY_CONNECTOR',aggregateId:replacement.connector_id,eventType:'CONNECTOR_REPLACED',actorEntityId:input.actorEntityId,actionId:input.actionId,payload:{replacesConnectorId:prior.connector_id,reason:'CREDENTIAL_OR_EXECUTION_IDENTITY_ROTATION'}});
  return{...replacement,replaces_connector_id:prior.connector_id};
}

export async function listDescriptorsP14(pool,{worldId,actorEntityId}){
  return withTransaction(pool,async(client)=>{const actor=await resolveActor(client,actorEntityId);if(actor.world_id!==worldId)throw problem('WORLD_MISMATCH','actor belongs to a different world',403);const r=await client.query(`SELECT d.descriptor_id,d.descriptor_key,d.version,d.model_reference,d.assurance_level,d.verification_status,d.status,d.max_input_tokens,d.max_output_tokens,d.timeout_ms,d.max_retries,d.supports_idempotency,d.supports_reconciliation,d.input_rate_micro_e_per_million,d.output_rate_micro_e_per_million,COALESCE(json_agg(json_build_object('connectorId',c.connector_id,'kind',c.connector_kind,'billingMode',c.billing_mode,'enabled',c.enabled)) FILTER (WHERE c.connector_id IS NOT NULL),'[]'::json) connectors FROM gateway.capability_descriptors d LEFT JOIN gateway.connector_configs c ON c.world_id=d.world_id AND c.descriptor_id=d.descriptor_id WHERE d.world_id=$1 GROUP BY d.descriptor_id ORDER BY d.created_at`,[worldId]);return r.rows;});
}

export async function quoteResource(client,{worldId,payerEntityId,activitySubjectId,descriptorId,maxInputTokens,maxOutputTokens,expiresAt,actorEntityId,actionId}){
  if(actorEntityId!==payerEntityId||activitySubjectId!==payerEntityId)throw problem('FORBIDDEN','P1 quote requires actor=activity subject=payer until delegation is implemented',403);
  maxInputTokens=positiveInt(maxInputTokens,'maxInputTokens');maxOutputTokens=positiveInt(maxOutputTokens,'maxOutputTokens');
  const d=(await client.query(`SELECT descriptor_id,version,status,max_input_tokens,max_output_tokens,input_rate_micro_e_per_million,output_rate_micro_e_per_million FROM gateway.capability_descriptors WHERE world_id=$1 AND descriptor_id=$2`,[worldId,descriptorId])).rows[0];
  if(!d||d.status!=='ACTIVE')throw problem('DESCRIPTOR_NOT_AVAILABLE','descriptor is missing or disabled',409);
  if(maxInputTokens>Number(d.max_input_tokens)||maxOutputTokens>Number(d.max_output_tokens))throw problem('MODEL_LIMIT_EXCEEDED','quote limits exceed descriptor limits',409);
  const expiry=expiresAt?new Date(expiresAt):new Date(Date.now()+600000);if(Number.isNaN(expiry.getTime())||expiry.getTime()<=Date.now()||expiry.getTime()>Date.now()+86400000)throw problem('INVALID_QUOTE_EXPIRY','quote expiry must be within the next 24 hours');
  const maxCost=calculateUsageCharge({inputTokens:maxInputTokens,outputTokens:maxOutputTokens,inputRateMicroEPerMillion:d.input_rate_micro_e_per_million,outputRateMicroEPerMillion:d.output_rate_micro_e_per_million});
  if(maxCost<=0n)throw problem('ZERO_COST_PLATFORM_QUOTE','platform-paid quote must reserve a positive maximum; use BYOK/external billing for zero platform model charge',409);
  const q=(await client.query(`INSERT INTO economy.resource_quotes (world_id,payer_entity_id,activity_subject_id,resource_kind,resource_ref,rate_version,input_rate_micro_e_per_million,output_rate_micro_e_per_million,max_input_tokens,max_output_tokens,max_cost_micro_e,status,expires_at,created_by) VALUES ($1,$2,$3,'MODEL_INFERENCE',$4,$5,$6,$7,$8,$9,$10,'ACTIVE',$11,$12) RETURNING *`,[worldId,payerEntityId,activitySubjectId,descriptorId,`descriptor:${descriptorId}:v${d.version}`,d.input_rate_micro_e_per_million,d.output_rate_micro_e_per_million,maxInputTokens,maxOutputTokens,maxCost.toString(),expiry.toISOString(),actorEntityId])).rows[0];
  if(actionId)await appendEvent(client,{worldId,aggregateType:'RESOURCE_QUOTE',aggregateId:q.quote_id,eventType:'RESOURCE_QUOTED',actorEntityId,actionId,payload:{payerEntityId,activitySubjectId,descriptorId,maxInputTokens,maxOutputTokens,maxCostMicroE:q.max_cost_micro_e,rateVersion:q.rate_version,expiresAt:q.expires_at}});
  return q;
}

export async function getQuote(client,{worldId,quoteId,actorEntityId}){const q=(await client.query('SELECT * FROM economy.resource_quotes WHERE world_id=$1 AND quote_id=$2',[worldId,quoteId])).rows[0];if(!q)throw problem('QUOTE_NOT_FOUND','quote not found',404);const a=await resolveActor(client,actorEntityId);if(a.world_id!==worldId)throw problem('WORLD_MISMATCH','actor belongs to a different world',403);if(a.entity_type!=='SYSTEM'&&a.entity_id!==q.payer_entity_id&&a.entity_id!==q.activity_subject_id)throw problem('FORBIDDEN','quote is not visible to this actor',403);return q;}

export async function reserveQuoted(client,{worldId,entityId,amountMicroE,businessKey,quoteId,actorEntityId,actionId}){
  if(!quoteId)throw problem('QUOTE_REQUIRED','quoteId is required',409);
  const q=(await client.query('SELECT * FROM economy.resource_quotes WHERE world_id=$1 AND quote_id=$2 FOR UPDATE',[worldId,quoteId])).rows[0];if(!q)throw problem('QUOTE_NOT_FOUND','quote not found',404);if(q.payer_entity_id!==entityId||q.activity_subject_id!==entityId)throw problem('INVALID_QUOTE','quote belongs to a different payer or activity subject',409);if(q.status!=='ACTIVE')throw problem('QUOTE_NOT_ACTIVE','quote is not active',409);if(new Date(q.expires_at).getTime()<=Date.now()){await client.query("UPDATE economy.resource_quotes SET status='EXPIRED' WHERE quote_id=$1",[quoteId]);throw problem('QUOTE_EXPIRED','quote expired',409);}const amount=amountMicroE??q.max_cost_micro_e;if(BigInt(amount)<BigInt(q.max_cost_micro_e))throw problem('QUOTE_RESERVATION_MISMATCH','reservation must cover quote maximum',409);
  const out=await reserve(client,{worldId,entityId,amountMicroE:String(amount),businessKey,actorEntityId,actionId});
  await client.query('UPDATE economy.reservations SET quote_id=$2 WHERE world_id=$1 AND reservation_id=$3',[worldId,quoteId,out.reservationId]);
  await client.query("UPDATE economy.resource_quotes SET status='RESERVED' WHERE world_id=$1 AND quote_id=$2 AND status='ACTIVE'",[worldId,quoteId]);
  return{...out,quoteId};
}

async function validateQuoteForInference(client,input){
  const plan=(await client.query(`SELECT c.billing_mode FROM gateway.connector_configs c WHERE c.world_id=$1 AND c.connector_id=$2 AND c.descriptor_id=$3 AND c.enabled=true`,[input.worldId,input.connectorId,input.descriptorId])).rows[0];if(!plan)throw problem('GATEWAY_NOT_AVAILABLE','connector unavailable',409);if(plan.billing_mode==='BYOK'){if(input.quoteId||input.reservationId)throw problem('BYOK_RESERVATION_NOT_ALLOWED','BYOK must not reserve platform Energy for external model cost',409);return{billingMode:'BYOK',maxChargeMicroE:'0'};}
  if(!input.quoteId||!input.reservationId)throw problem('QUOTE_REQUIRED','platform-paid inference requires quoteId and quote-backed reservation',409);
  const row=(await client.query(`SELECT q.*,r.amount_micro_e reservation_amount,r.status reservation_status,r.quote_id reservation_quote FROM economy.resource_quotes q JOIN economy.reservations r ON r.world_id=q.world_id AND r.reservation_id=$3 WHERE q.world_id=$1 AND q.quote_id=$2 FOR UPDATE OF q,r`,[input.worldId,input.quoteId,input.reservationId])).rows[0];if(!row)throw problem('INVALID_QUOTE','quote/reservation link not found',409);if(row.status!=='RESERVED'||row.reservation_status!=='ACTIVE'||row.reservation_quote!==input.quoteId)throw problem('INVALID_QUOTE','quote or reservation is not active/bound',409);if(row.payer_entity_id!==input.payerEntityId||row.activity_subject_id!==input.activitySubjectId||row.resource_ref!==input.descriptorId)throw problem('INVALID_QUOTE','quote scope mismatch',409);if(new Date(row.expires_at).getTime()<=Date.now())throw problem('QUOTE_EXPIRED','quote expired',409);const inputBound=conservativeInputTokenUpperBound(input.messages);const maxOutput=input.maxOutputTokens??row.max_output_tokens;if(inputBound>Number(row.max_input_tokens)||maxOutput>Number(row.max_output_tokens))throw problem('QUOTE_SCOPE_EXCEEDED','request exceeds quote limits',409);if(BigInt(row.reservation_amount)<BigInt(row.max_cost_micro_e))throw problem('RESERVATION_TOO_SMALL','reservation does not cover quote maximum',409);return{billingMode:'PLATFORM_PREPAID',maxChargeMicroE:row.max_cost_micro_e};
}

export async function inferQuoted(pool,input,options={}){const auth=await withTransaction(pool,(c)=>validateQuoteForInference(c,input));return infer(pool,{...input,maxChargeMicroE:auth.maxChargeMicroE},options);}

export async function getUsageReceipt(pool,{worldId,receiptId,actorEntityId}){return withTransaction(pool,async(client)=>{const a=await resolveActor(client,actorEntityId);if(a.world_id!==worldId)throw problem('WORLD_MISMATCH','actor belongs to a different world',403);const r=(await client.query(`SELECT u.receipt_id,u.execution_id,u.attempt_id,u.provider_request_id,u.input_tokens,u.output_tokens,u.total_tokens,u.charge_micro_e,u.external_billing,u.status,u.raw_usage,u.created_at,e.action_id,e.activity_subject_id,e.payer_entity_id,e.quote_id FROM gateway.usage_receipts u JOIN gateway.executions e ON e.world_id=u.world_id AND e.execution_id=u.execution_id WHERE u.world_id=$1 AND u.receipt_id=$2`,[worldId,receiptId])).rows[0];if(!r)throw problem('USAGE_RECEIPT_NOT_FOUND','usage receipt not found',404);if(a.entity_type!=='SYSTEM'&&a.entity_id!==r.activity_subject_id&&a.entity_id!==r.payer_entity_id)throw problem('FORBIDDEN','usage receipt is not visible to this actor',403);return r;});}

export async function cancelExecution(client,{worldId,executionId,actorEntityId,actionId}){const a=await resolveActor(client,actorEntityId);if(a.world_id!==worldId)throw problem('WORLD_MISMATCH','actor belongs to a different world',403);const row=(await client.query('SELECT * FROM gateway.executions WHERE world_id=$1 AND execution_id=$2 FOR UPDATE',[worldId,executionId])).rows[0];if(!row)throw problem('EXECUTION_NOT_FOUND','execution not found',404);if(a.entity_type!=='SYSTEM'&&a.entity_id!==row.activity_subject_id&&a.entity_id!==row.payer_entity_id)throw problem('FORBIDDEN','execution cannot be cancelled by this actor',403);if(['SUCCEEDED','FAILED','OUTCOME_UNKNOWN','CANCELLED'].includes(row.status))return{executionId,status:row.status,cancellationAccepted:row.status==='CANCELLED',replayed:true};if(row.status==='DISPATCHED')return{executionId,status:'DISPATCHED',cancellationAccepted:false,reason:'ALREADY_DISPATCHED'};if(row.status!=='PROPOSED')throw problem('EXECUTION_NOT_CANCELLABLE','execution is not cancellable',409);if(row.reservation_id){if(a.entity_id!==row.payer_entity_id)throw problem('FORBIDDEN','P1 SYSTEM/delegated cancellation of another payer reservation is not implemented',403);await releaseReservation(client,{worldId,entityId:row.payer_entity_id,reservationId:row.reservation_id,actorEntityId:a.entity_id,actionId:actionId??row.action_id});}const result={executionId,status:'CANCELLED',cancellationAccepted:true,quoteId:row.quote_id??null};await client.query("UPDATE gateway.executions SET status='CANCELLED',error_code='CANCELLED_BY_ACTOR',result_json=$3::jsonb,completed_at=now() WHERE world_id=$1 AND execution_id=$2",[worldId,executionId,JSON.stringify(result)]);await client.query("UPDATE core.actions SET status='CANCELLED',error_code='CANCELLED_BY_ACTOR',result_json=$3::jsonb,completed_at=now() WHERE world_id=$1 AND action_id=$2",[worldId,row.action_id,JSON.stringify(result)]);await appendEvent(client,{worldId,aggregateType:'GATEWAY_EXECUTION',aggregateId:executionId,eventType:'EXECUTION_CANCELLED',actorEntityId,actionId:actionId??row.action_id,payload:{quoteId:row.quote_id??null,reservationId:row.reservation_id??null}});return result;}
