import crypto from 'node:crypto';
import { withTransaction } from '../db.js';
import { ECONOMY_PORT_VERSION } from '../ports/economy_port.js';
import {
  claimSagaOutbox,
  recordSagaDispatchFailure,
  recordSagaFinancialResult,
} from './cross_product_saga_store.js';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    const error = new Error(field + ' must be a non-empty string');
    error.code = 'INVALID_SAGA_WORKER_INPUT';
    throw error;
  }
}

function objectSnapshot(value, field) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error(field + ' must be an object snapshot');
    error.code = 'INVALID_SAGA_OUTBOX';
    throw error;
  }
  return parsed;
}

function requestFor(command) {
  return {
    contract_version: ECONOMY_PORT_VERSION,
    operation: command.operation,
    request_id: crypto.randomUUID(),
    idempotency_key: command.idempotency_key,
    principal_ref: command.principal_ref,
    payload: objectSnapshot(command.payload, 'command.payload'),
  };
}

function successReference(response) {
  return response.operation_ref
    ?? response.result?.escrow_ref
    ?? response.result?.operation_ref
    ?? response.result?.settlement_ref
    ?? null;
}

/**
 * Dispatch exactly one durable Outbox item. A new request_id is transport metadata;
 * the operation_key/idempotency_key and payload digest never change across attempts.
 * A real KB adapter must be injected; this worker never falls back to local economy.
 */
export async function dispatchSagaOutboxOnce(pool, {
  workerId,
  economyPort,
  worldId,
  leaseMs = 30_000,
  maxAttempts = 5,
  retryAfterMs = 1_000,
} = {}) {
  requireText(workerId, 'workerId');
  if (!economyPort || typeof economyPort.escrow !== 'function') {
    const error = new Error('Authoritative Knowledge Ball EconomyPort is required');
    error.code = 'KB_ECONOMY_PORT_UNAVAILABLE';
    throw error;
  }
  const claimed = await claimSagaOutbox(pool, { workerId, leaseMs, worldId });
  if (!claimed) return { claimed: false, outcome: 'IDLE' };

  const command = objectSnapshot(claimed.command_snapshot, 'command_snapshot');
  if (command.operation !== 'escrow'
      || command.operation_key !== claimed.operation_key
      || command.idempotency_key !== claimed.operation_key
      || command.payload_digest !== claimed.payload_digest) {
    await withTransaction(pool, (client) => recordSagaDispatchFailure(client, {
      outboxId: claimed.outbox_id, leaseOwner: workerId,
      errorCode: 'SAGA_OUTBOX_IDENTITY_MISMATCH', retryable: false,
    }));
    return { claimed: true, outcome: 'DEAD_LETTER', outboxId: claimed.outbox_id };
  }

  let response;
  try {
    response = await economyPort.escrow(requestFor(command));
  } catch (error) {
    // Unless the transport explicitly proves that no request was dispatched,
    // a thrown network error is ambiguous for a funds write.
    const confirmedNoEffect = error?.confirmedNoEffect === true;
    const code = typeof error?.code === 'string' && error.code.trim() ? error.code : 'TRANSPORT_OUTCOME_UNKNOWN';
    await withTransaction(pool, (client) => recordSagaDispatchFailure(client, {
      outboxId: claimed.outbox_id,
      leaseOwner: workerId,
      errorCode: code,
      retryable: confirmedNoEffect,
      outcomeUnknown: !confirmedNoEffect,
      retryAfterMs,
      maxAttempts,
    }));
    return { claimed: true, outcome: confirmedNoEffect ? 'RETRY_SCHEDULED' : 'RECONCILIATION_REQUIRED', outboxId: claimed.outbox_id, errorCode: code };
  }

  if (response.status === 'SUCCEEDED' || response.status === 'DUPLICATE') {
    const resultRef = successReference(response);
    if (!resultRef) {
      await withTransaction(pool, (client) => recordSagaDispatchFailure(client, {
        outboxId: claimed.outbox_id, leaseOwner: workerId,
        errorCode: 'KB_SUCCESS_MISSING_OPERATION_REFERENCE', outcomeUnknown: true,
        retryAfterMs,
      }));
      return { claimed: true, outcome: 'RECONCILIATION_REQUIRED', outboxId: claimed.outbox_id };
    }
    const result = {
      operation_key: command.operation_key,
      payload_digest: command.payload_digest,
      status: 'SUCCEEDED',
      result_ref: resultRef,
    };
    const recorded = await withTransaction(pool, (client) => recordSagaFinancialResult(client, {
      worldId: claimed.world_id,
      operationKey: command.operation_key,
      result,
      sourceEventId: 'outbox:' + claimed.outbox_id + ':attempt:' + claimed.attempts,
    }));
    return { claimed: true, outcome: recorded.conflict ? 'RECONCILIATION_REQUIRED' : 'DELIVERED', outboxId: claimed.outbox_id, sagaState: recorded.saga.state };
  }

  const errorCode = response.error?.code ?? response.status ?? 'KB_OPERATION_FAILED';
  if (response.status === 'OUTCOME_UNKNOWN') {
    await withTransaction(pool, (client) => recordSagaDispatchFailure(client, {
      outboxId: claimed.outbox_id, leaseOwner: workerId, errorCode,
      outcomeUnknown: true, retryAfterMs,
    }));
    return { claimed: true, outcome: 'RECONCILIATION_REQUIRED', outboxId: claimed.outbox_id, errorCode };
  }
  if (response.status === 'TIMEOUT' || response.status === 'UNAVAILABLE') {
    await withTransaction(pool, (client) => recordSagaDispatchFailure(client, {
      outboxId: claimed.outbox_id, leaseOwner: workerId, errorCode,
      retryable: true, retryAfterMs, maxAttempts,
    }));
    return { claimed: true, outcome: 'RETRY_SCHEDULED', outboxId: claimed.outbox_id, errorCode };
  }

  const result = {
    operation_key: command.operation_key,
    payload_digest: command.payload_digest,
    status: 'FAILED',
    error_code: errorCode,
  };
  const recorded = await withTransaction(pool, (client) => recordSagaFinancialResult(client, {
    worldId: claimed.world_id,
    operationKey: command.operation_key,
    result,
    sourceEventId: 'outbox:' + claimed.outbox_id + ':attempt:' + claimed.attempts,
  }));
  return { claimed: true, outcome: recorded.conflict ? 'RECONCILIATION_REQUIRED' : 'FAILED', outboxId: claimed.outbox_id, errorCode, sagaState: recorded.saga.state };
}

/**
 * Reconcile one due ambiguous Saga using an authoritative idempotency lookup.
 * lookupOperationByIdempotencyKey must return {state:'FOUND', result}, {state:'NOT_FOUND'},
 * or {state:'UNKNOWN'}. NOT_FOUND is the only state that permits same-key replay.
 */
export async function reconcileSagaOnce(pool, {
  workerId,
  lookupOperationByIdempotencyKey,
  leaseMs = 30_000,
  retryAfterMs = 5_000,
} = {}) {
  requireText(workerId, 'workerId');
  if (typeof lookupOperationByIdempotencyKey !== 'function') {
    const error = new Error('Authoritative idempotency lookup is required for Saga reconciliation');
    error.code = 'KB_RECONCILIATION_UNAVAILABLE';
    throw error;
  }
  const claimed = await withTransaction(pool, async (client) => {
    const result = await client.query(
      "SELECT s.*,o.outbox_id,o.operation_key,o.payload_digest AS outbox_payload_digest,o.status AS outbox_status,o.command_snapshot " +
      "FROM social.cross_product_sagas s JOIN social.cross_product_outbox o ON o.world_id=s.world_id AND o.saga_id=s.saga_id " +
      "AND o.operation_key IN (s.primary_operation_key,s.compensation_operation_key) " +
      "WHERE s.state='RECONCILIATION_REQUIRED' AND s.next_reconcile_at <= now() AND o.status='RECONCILIATION_REQUIRED' " +
      "ORDER BY s.next_reconcile_at,s.updated_at FOR UPDATE OF s,o SKIP LOCKED LIMIT 1",
    );
    if (result.rowCount !== 1) return null;
    const row = result.rows[0];
    const leasedUntil = new Date(Date.now() + leaseMs);
    await client.query(
      'UPDATE social.cross_product_sagas SET next_reconcile_at=$3,updated_at=now() WHERE world_id=$1 AND saga_id=$2',
      [row.world_id,row.saga_id,leasedUntil],
    );
    return row;
  });
  if (!claimed) return { claimed: false, outcome: 'IDLE' };

  let lookup;
  try {
    lookup = await lookupOperationByIdempotencyKey({
      worldId: claimed.world_id,
      operationKey: claimed.operation_key,
      payloadDigest: claimed.outbox_payload_digest,
    });
  } catch (error) {
    await withTransaction(pool, (client) => client.query(
      'UPDATE social.cross_product_sagas SET next_reconcile_at=now()+($3::integer * interval \'1 millisecond\'),last_error_code=$4,last_error_at=now(),updated_at=now() WHERE world_id=$1 AND saga_id=$2 AND state=\'RECONCILIATION_REQUIRED\'',
      [claimed.world_id,claimed.saga_id,retryAfterMs,typeof error?.code === 'string' ? error.code : 'KB_RECONCILIATION_QUERY_FAILED'],
    ));
    return { claimed: true, outcome: 'RETRY_RECONCILIATION', sagaId: claimed.saga_id };
  }

  if (lookup?.state === 'FOUND') {
    const result = lookup.result;
    const recorded = await withTransaction(pool, (client) => recordSagaFinancialResult(client, {
      worldId: claimed.world_id,
      operationKey: claimed.operation_key,
      result,
      sourceEventId: 'reconcile:' + workerId + ':' + claimed.operation_key,
    }));
    return { claimed: true, outcome: recorded.conflict ? 'RECONCILIATION_REQUIRED' : 'RESOLVED', sagaId: claimed.saga_id, sagaState: recorded.saga.state };
  }

  if (lookup?.state === 'NOT_FOUND') {
    return withTransaction(pool, async (client) => {
      const current = await client.query('SELECT * FROM social.cross_product_sagas WHERE world_id=$1 AND saga_id=$2 FOR UPDATE', [claimed.world_id,claimed.saga_id]);
      if (current.rowCount !== 1 || current.rows[0].state !== 'RECONCILIATION_REQUIRED') {
        return { claimed: true, outcome: 'STALE_RECONCILIATION', sagaId: claimed.saga_id };
      }
      const snapshot = typeof current.rows[0].saga_snapshot === 'string' ? JSON.parse(current.rows[0].saga_snapshot) : current.rows[0].saga_snapshot;
      if (snapshot.primary_result || snapshot.compensation_result) {
        return { claimed: true, outcome: 'RECONCILIATION_REQUIRED', sagaId: claimed.saga_id };
      }
      snapshot.state = snapshot.primary_operation_key === claimed.operation_key ? 'PENDING_REMOTE' : 'COMPENSATION_PENDING';
      await client.query(
        "UPDATE social.cross_product_sagas SET state=$3,saga_snapshot=$4::jsonb,next_reconcile_at=NULL,version=version+1,updated_at=now() WHERE world_id=$1 AND saga_id=$2",
        [claimed.world_id,claimed.saga_id,snapshot.state,JSON.stringify(snapshot)],
      );
      await client.query(
        "UPDATE social.cross_product_outbox SET status='RETRY_WAIT',next_attempt_at=now(),last_error_code=NULL,updated_at=now() WHERE outbox_id=$1 AND status='RECONCILIATION_REQUIRED'",
        [claimed.outbox_id],
      );
      return { claimed: true, outcome: 'SAME_KEY_RETRY_SCHEDULED', sagaId: claimed.saga_id, operationKey: claimed.operation_key };
    });
  }

  await withTransaction(pool, (client) => client.query(
    'UPDATE social.cross_product_sagas SET next_reconcile_at=now()+($3::integer * interval \'1 millisecond\'),updated_at=now() WHERE world_id=$1 AND saga_id=$2 AND state=\'RECONCILIATION_REQUIRED\'',
    [claimed.world_id,claimed.saga_id,retryAfterMs],
  ));
  return { claimed: true, outcome: 'RETRY_RECONCILIATION', sagaId: claimed.saga_id };
}
