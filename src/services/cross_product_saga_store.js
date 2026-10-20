import crypto from 'node:crypto';
import { withTransaction } from '../db.js';
import {
  SagaState,
  canonicalJson,
  buildFinancialCommand,
  observeFinancialResult,
  markLocalTransitionCommitted,
} from '../shared/cross_product_saga.js';

function problem(code, message) {
  return Object.assign(new Error(message), { code });
}
function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw problem('INVALID_SAGA_INPUT', field + ' must be a non-empty string');
}
function snapshotOf(row) {
  return typeof row.saga_snapshot === 'string' ? JSON.parse(row.saga_snapshot) : row.saga_snapshot;
}
function sameJson(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}
function normalizeResult(result, operationKey) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw problem('INVALID_SAGA_RESULT', 'result must be an object');
  const key = result.operation_key ?? result.idempotency_key ?? operationKey;
  requireText(key, 'operationKey');
  requireText(result.payload_digest, 'payload_digest');
  if (!['SUCCEEDED', 'FAILED'].includes(result.status)) throw problem('INVALID_SAGA_RESULT', 'status must be SUCCEEDED or FAILED');
  if (result.status === 'SUCCEEDED') requireText(result.result_ref, 'result_ref');
  return { operation_key: key, payload_digest: result.payload_digest, status: result.status, result_ref: result.result_ref ?? null, error_code: result.error_code ?? null };
}

/** Caller must include this in the NH-local transaction that prepares the transition. */
export async function prepareSagaIntent(client, saga) {
  const command = buildFinancialCommand(saga);
  if (!command) throw problem('INVALID_SAGA_STATE', 'Saga has no pending financial command');
  const inserted = await client.query(
    "INSERT INTO social.cross_product_sagas (saga_id,world_id,contract_id,contract_version,kind,business_attempt_id,state,primary_operation_key,primary_payload_digest,compensation_operation_key,saga_snapshot) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT (world_id,kind,business_attempt_id) DO NOTHING RETURNING *",
    [saga.saga_id,saga.world_id,saga.contract_id,saga.contract_version,saga.kind,saga.business_attempt_id,saga.state,saga.primary_operation_key,saga.primary_payload_digest,saga.compensation_operation_key,JSON.stringify(saga)],
  );
  if (inserted.rowCount === 0) {
    const existing = await client.query(
      'SELECT * FROM social.cross_product_sagas WHERE world_id=$1 AND kind=$2 AND business_attempt_id=$3 FOR UPDATE',
      [saga.world_id,saga.kind,saga.business_attempt_id],
    );
    if (existing.rowCount !== 1) throw problem('SAGA_ALREADY_ACTIVE', 'another Saga owns this contract transition');
    const row = existing.rows[0];
    if (row.primary_payload_digest !== saga.primary_payload_digest || row.contract_id !== saga.contract_id || Number(row.contract_version) !== saga.contract_version) {
      throw problem('SAGA_IDEMPOTENCY_CONFLICT', 'business attempt replay changed immutable intent');
    }
    return { saga: row, outbox: null, replayed: true };
  }
  const outbox = await client.query(
    "INSERT INTO social.cross_product_outbox (world_id,saga_id,business_attempt_id,operation_key,payload_digest,command_snapshot) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *",
    [saga.world_id,saga.saga_id,saga.business_attempt_id,command.operation_key,command.payload_digest,JSON.stringify(command)],
  );
  return { saga: inserted.rows[0], outbox: outbox.rows[0], replayed: false };
}

/** At-least-once outbox claim with expired-lease recovery and SKIP LOCKED. */
export async function claimSagaOutbox(pool, { workerId, leaseMs = 30_000 } = {}) {
  requireText(workerId, 'workerId');
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw problem('INVALID_SAGA_INPUT', 'leaseMs must be 1000..300000');
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      "WITH candidate AS (SELECT outbox_id FROM social.cross_product_outbox WHERE (status IN ('PENDING','RETRY_WAIT') AND next_attempt_at <= now()) OR (status='LEASED' AND lease_until < now()) ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1) " +
      "UPDATE social.cross_product_outbox o SET status='LEASED',attempts=o.attempts+1,lease_owner=$1,lease_until=now()+($2::integer * interval '1 millisecond'),updated_at=now() FROM candidate WHERE o.outbox_id=candidate.outbox_id RETURNING o.*",
      [workerId,leaseMs],
    );
    return result.rows[0] ?? null;
  });
}

/** Failure handling never changes the logical funds key or command snapshot. */
export async function recordSagaDispatchFailure(client, { outboxId, leaseOwner, errorCode, retryable = false, outcomeUnknown = false, retryAfterMs = 1000, maxAttempts = 5 }) {
  requireText(outboxId, 'outboxId'); requireText(leaseOwner, 'leaseOwner'); requireText(errorCode, 'errorCode');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw problem('INVALID_SAGA_INPUT', 'maxAttempts must be positive');
  const selected = await client.query("SELECT * FROM social.cross_product_outbox WHERE outbox_id=$1 AND status='LEASED' AND lease_owner=$2 FOR UPDATE", [outboxId,leaseOwner]);
  if (selected.rowCount !== 1) throw problem('SAGA_OUTBOX_LEASE_LOST', 'outbox lease is no longer owned by this worker');
  const row = selected.rows[0];
  const status = outcomeUnknown ? 'RECONCILIATION_REQUIRED' : retryable && row.attempts < maxAttempts ? 'RETRY_WAIT' : 'DEAD_LETTER';
  const delay = Number.isInteger(retryAfterMs) ? Math.max(0,Math.min(retryAfterMs,3_600_000)) : 1000;
  const updated = await client.query(
    'UPDATE social.cross_product_outbox SET status=$3,next_attempt_at=now()+($4::integer * interval \'1 millisecond\'),lease_owner=NULL,lease_until=NULL,last_error_code=$5,updated_at=now() WHERE outbox_id=$1 AND lease_owner=$2 RETURNING *',
    [outboxId,leaseOwner,status,delay,errorCode],
  );
  if (outcomeUnknown) {
    await client.query(
      "UPDATE social.cross_product_sagas SET state='RECONCILIATION_REQUIRED',saga_snapshot=jsonb_set(saga_snapshot,'{state}','\"RECONCILIATION_REQUIRED\"'::jsonb),last_error_code=$2,last_error_at=now(),next_reconcile_at=now()+($3::integer * interval '1 millisecond'),version=version+1,updated_at=now() WHERE saga_id=$1 AND world_id=$4 AND state NOT IN ('COMPLETED','COMPENSATED','FAILED')",
      [row.saga_id,errorCode,delay,row.world_id],
    );
  } else if (status === 'DEAD_LETTER') {
    await client.query('UPDATE social.cross_product_sagas SET last_error_code=$2,last_error_at=now(),version=version+1,updated_at=now() WHERE saga_id=$1 AND world_id=$3',[row.saga_id,errorCode,row.world_id]);
  }
  return updated.rows[0];
}

/** Inbox dedupe, immutable result identity, and Saga transition commit in one NH transaction. */
export async function recordSagaFinancialResult(client, { worldId, operationKey, result, sourceEventId = null }) {
  requireText(worldId,'worldId'); requireText(operationKey,'operationKey');
  const normalized = normalizeResult(result,operationKey);
  if (normalized.operation_key !== operationKey) throw problem('UNEXPECTED_SAGA_OPERATION','result operation key does not match inbox key');
  const found = await client.query(
    'SELECT s.*,o.outbox_id,o.status AS outbox_status FROM social.cross_product_sagas s JOIN social.cross_product_outbox o ON o.world_id=s.world_id AND o.saga_id=s.saga_id AND o.operation_key=$2 WHERE s.world_id=$1 FOR UPDATE OF s,o',
    [worldId,operationKey],
  );
  if (found.rowCount !== 1) throw problem('SAGA_OPERATION_NOT_FOUND','result does not match a persisted Saga operation');
  const row = found.rows[0];
  const inserted = await client.query(
    'INSERT INTO social.cross_product_inbox (world_id,operation_key,payload_digest,result_snapshot,source_event_id) VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (world_id,operation_key) DO NOTHING RETURNING *',
    [worldId,operationKey,normalized.payload_digest,JSON.stringify(normalized),sourceEventId],
  );
  if (inserted.rowCount === 0) {
    const prior = await client.query('SELECT * FROM social.cross_product_inbox WHERE world_id=$1 AND operation_key=$2 FOR UPDATE',[worldId,operationKey]);
    const priorResult = typeof prior.rows[0].result_snapshot === 'string' ? JSON.parse(prior.rows[0].result_snapshot) : prior.rows[0].result_snapshot;
    if (prior.rows[0].payload_digest === normalized.payload_digest && sameJson(priorResult,normalized)) return { duplicate: true, conflict: false, saga: row, outbox: null };
    await client.query("UPDATE social.cross_product_sagas SET state='RECONCILIATION_REQUIRED',saga_snapshot=jsonb_set(saga_snapshot,'{state}','\"RECONCILIATION_REQUIRED\"'::jsonb),last_error_code='SAGA_RESULT_CONFLICT',last_error_at=now(),next_reconcile_at=now(),version=version+1,updated_at=now() WHERE saga_id=$1 AND world_id=$2",[row.saga_id,worldId]);
    await client.query("UPDATE social.cross_product_outbox SET status='RECONCILIATION_REQUIRED',lease_owner=NULL,lease_until=NULL,last_error_code='SAGA_RESULT_CONFLICT',updated_at=now() WHERE outbox_id=$1",[row.outbox_id]);
    return { duplicate: false, conflict: true, saga: { ...row, state: SagaState.RECONCILIATION_REQUIRED }, outbox: null };
  }
  let next;
  try { next = observeFinancialResult(snapshotOf(row),normalized); }
  catch (error) {
    if (!['SAGA_IDEMPOTENCY_CONFLICT','SAGA_RESULT_CONFLICT'].includes(error?.code)) throw error;
    await client.query("UPDATE social.cross_product_sagas SET state='RECONCILIATION_REQUIRED',saga_snapshot=jsonb_set(saga_snapshot,'{state}','\"RECONCILIATION_REQUIRED\"'::jsonb),last_error_code=$2,last_error_at=now(),next_reconcile_at=now(),version=version+1,updated_at=now() WHERE saga_id=$1 AND world_id=$3",[row.saga_id,error.code,worldId]);
    await client.query("UPDATE social.cross_product_outbox SET status='RECONCILIATION_REQUIRED',lease_owner=NULL,lease_until=NULL,last_error_code=$2,updated_at=now() WHERE outbox_id=$1",[row.outbox_id,error.code]);
    return { duplicate: false, conflict: true, saga: { ...row, state: SagaState.RECONCILIATION_REQUIRED }, outbox: null };
  }
  const updated = await client.query(
    'UPDATE social.cross_product_sagas SET state=$3,saga_snapshot=$4::jsonb,version=version+1,last_error_code=$5::text,last_error_at=CASE WHEN $5::text IS NULL THEN last_error_at ELSE now() END,next_reconcile_at=NULL,updated_at=now() WHERE saga_id=$1 AND world_id=$2 AND version=$6 RETURNING *',
    [row.saga_id,worldId,next.state,JSON.stringify(next),normalized.error_code,row.version],
  );
  if (updated.rowCount !== 1) throw problem('SAGA_VERSION_CONFLICT','Saga version changed while recording result');
  await client.query("UPDATE social.cross_product_outbox SET status='DELIVERED',delivered_at=COALESCE(delivered_at,now()),lease_owner=NULL,lease_until=NULL,last_error_code=NULL,updated_at=now() WHERE outbox_id=$1",[row.outbox_id]);
  return { duplicate: false, conflict: false, saga: updated.rows[0], outbox: null };
}

/** Caller updates social.contracts in this same transaction before committing. */
export async function markPersistedSagaLocalTransitionCommitted(client, { worldId, sagaId, localContractState }) {
  requireText(worldId,'worldId'); requireText(sagaId,'sagaId');
  const found = await client.query('SELECT * FROM social.cross_product_sagas WHERE world_id=$1 AND saga_id=$2 FOR UPDATE',[worldId,sagaId]);
  if (found.rowCount !== 1) throw problem('SAGA_NOT_FOUND','persisted Saga not found');
  const row = found.rows[0];
  const next = markLocalTransitionCommitted(snapshotOf(row),localContractState);
  const updated = await client.query(
    'UPDATE social.cross_product_sagas SET state=$3,saga_snapshot=$4::jsonb,version=version+1,next_reconcile_at=NULL,updated_at=now() WHERE world_id=$1 AND saga_id=$2 AND version=$5 RETURNING *',
    [worldId,sagaId,next.state,JSON.stringify(next),row.version],
  );
  if (updated.rowCount !== 1) throw problem('SAGA_VERSION_CONFLICT','Saga version changed while committing local transition');
  return updated.rows[0];
}
