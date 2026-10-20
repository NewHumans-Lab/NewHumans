import {
  SagaKind,
  SagaState,
  buildFinancialCommand,
  createContractActivationSaga,
  createContractSettlementSaga,
  requestActivationCompensation,
} from '../shared/cross_product_saga.js';
import { prepareSagaIntent, markPersistedSagaLocalTransitionCommitted } from './cross_product_saga_store.js';

function problem(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}
function nonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw problem('INVALID_CONTRACT_SAGA_INPUT', field + ' must be a non-empty string', 400);
}
function positiveVersion(value) {
  if (!Number.isInteger(value) || value < 1) throw problem('INVALID_CONTRACT_SAGA_INPUT', 'contractVersion must be a positive integer', 400);
}
function hasCriteria(value) {
  return value !== null && value !== undefined && JSON.stringify(value) !== 'null'
    && JSON.stringify(value) !== '{}' && JSON.stringify(value) !== '[]';
}
async function lockContractVersion(client, { worldId, contractId }) {
  const result = await client.query(
    'SELECT c.contract_id,c.world_id,c.status,c.current_version,c.employer_entity_id,c.contractor_entity_id,c.escrow_external_ref,v.price_micro_e,v.acceptance_criteria ' +
    'FROM social.contracts c LEFT JOIN social.contract_versions v ON v.world_id=c.world_id AND v.contract_id=c.contract_id AND v.version=c.current_version ' +
    'WHERE c.world_id=$1 AND c.contract_id=$2 FOR UPDATE OF c',
    [worldId, contractId],
  );
  if (result.rowCount !== 1) throw problem('CONTRACT_NOT_FOUND', 'contract not found', 404);
  return result.rows[0];
}
async function acceptanceCount(client, contract) {
  const result = await client.query(
    'SELECT count(DISTINCT party_entity_id)::integer AS count FROM social.contract_acceptances ' +
    'WHERE world_id=$1 AND contract_id=$2 AND version=$3 AND invalidated_at IS NULL AND party_entity_id IN ($4,$5)',
    [contract.world_id, contract.contract_id, contract.current_version, contract.employer_entity_id, contract.contractor_entity_id],
  );
  return result.rows[0].count;
}
function validateEscrowSnapshot(snapshot, expectedEscrowRef) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw problem('AUTHORITATIVE_ESCROW_SNAPSHOT_REQUIRED', 'settlement requires a trusted authoritative escrow balance snapshot');
  }
  nonEmpty(snapshot.escrowRef, 'escrowSnapshot.escrowRef');
  nonEmpty(snapshot.balanceMicroE, 'escrowSnapshot.balanceMicroE');
  nonEmpty(snapshot.authorityVersion, 'escrowSnapshot.authorityVersion');
  nonEmpty(snapshot.receiptRef, 'escrowSnapshot.receiptRef');
  nonEmpty(snapshot.observedAt, 'escrowSnapshot.observedAt');
  if (snapshot.escrowRef !== expectedEscrowRef) {
    throw problem('CONTRACT_ESCROW_REFERENCE_MISMATCH', 'authoritative snapshot must refer to the contract escrow');
  }
  if (!/^(0|[1-9]\d*)$/.test(snapshot.balanceMicroE) || BigInt(snapshot.balanceMicroE) <= 0n) {
    throw problem('ESCROW_BALANCE_NOT_DISTRIBUTABLE', 'authoritative escrow balance must be a positive integer microE string');
  }
  if (!/^(0|[1-9]\\d*)$/.test(snapshot.authorityVersion)) {
    throw problem('INVALID_ESCROW_SNAPSHOT', 'authoritative escrow resource version must be a non-negative integer string', 400);
  }
  if (!Number.isFinite(Date.parse(snapshot.observedAt))) {
    throw problem('INVALID_ESCROW_SNAPSHOT', 'authoritative escrow snapshot observation time must be a timestamp', 400);
  }
  return {
    escrowRef: snapshot.escrowRef,
    balanceMicroE: snapshot.balanceMicroE,
    authorityVersion: snapshot.authorityVersion,
    receiptRef: snapshot.receiptRef,
    observedAt: new Date(snapshot.observedAt).toISOString(),
  };
}

function assertAllocations(allocations, amountMicroE) {
  if (!Array.isArray(allocations) || allocations.length === 0) throw problem('INVALID_CONTRACT_SAGA_INPUT', 'allocations must be a non-empty array', 400);
  let total = 0n;
  for (const [index, item] of allocations.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw problem('INVALID_CONTRACT_SAGA_INPUT', 'allocation ' + index + ' must be an object', 400);
    nonEmpty(item.principal_ref, 'allocations[' + index + '].principal_ref');
    if (typeof item.amount_micro_e !== 'string' || !/^(0|[1-9]\d*)$/.test(item.amount_micro_e)) {
      throw problem('INVALID_CONTRACT_SAGA_INPUT', 'allocation amounts must be non-negative integer strings', 400);
    }
    total += BigInt(item.amount_micro_e);
  }
  if (total !== BigInt(amountMicroE)) throw problem('INVALID_CONTRACT_SAGA_INPUT', 'allocation total must equal the authoritative distributable escrow balance', 400);
}

/** Prepare activation Saga + Outbox inside the same NH-local transaction as the command. */
export async function prepareContractActivation(client, input) {
  nonEmpty(input.worldId, 'worldId'); nonEmpty(input.contractId, 'contractId');
  nonEmpty(input.sagaId, 'sagaId'); nonEmpty(input.businessAttemptId, 'businessAttemptId');
  nonEmpty(input.principalRef, 'principalRef'); nonEmpty(input.contractRef, 'contractRef');
  const contract = await lockContractVersion(client, input);
  if (contract.status !== 'PROPOSED') throw problem('CONTRACT_NOT_ACTIVATABLE', 'only a PROPOSED contract can begin activation');
  if (!Number.isInteger(contract.current_version) || contract.current_version < 1 || !contract.price_micro_e) {
    throw problem('CONTRACT_VERSION_REQUIRED', 'activation requires a published contract version');
  }
  if (!hasCriteria(contract.acceptance_criteria)) throw problem('CONTRACT_ACCEPTANCE_CRITERIA_REQUIRED', 'activation requires non-empty acceptance criteria');
  if (await acceptanceCount(client, contract) !== 2) throw problem('CONTRACT_ACCEPTANCE_REQUIRED', 'both parties must accept the current contract version');
  const payload = {
    contract_ref: input.contractRef,
    amount_micro_e: String(contract.price_micro_e),
    ...(input.prepayAllocations === undefined ? { prepay_allocations: [] } : { prepay_allocations: input.prepayAllocations }),
  };
  const saga = createContractActivationSaga({
    sagaId: input.sagaId, worldId: input.worldId, contractId: input.contractId,
    contractVersion: contract.current_version, businessAttemptId: input.businessAttemptId,
    escrowRequest: { principal_ref: input.principalRef, payload },
  });
  return prepareSagaIntent(client, saga);
}

/** Prepare settlement distribution; caller supplies the authoritative allocation decision. */
export async function prepareContractSettlement(client, input) {
  nonEmpty(input.worldId, 'worldId'); nonEmpty(input.contractId, 'contractId');
  nonEmpty(input.sagaId, 'sagaId'); nonEmpty(input.businessAttemptId, 'businessAttemptId');
  nonEmpty(input.principalRef, 'principalRef'); nonEmpty(input.contractRef, 'contractRef');
  nonEmpty(input.escrowRef, 'escrowRef');
  const contract = await lockContractVersion(client, input);
  if (!['SUBMITTED','DISPUTED'].includes(contract.status)) throw problem('CONTRACT_NOT_SETTLEABLE', 'settlement requires SUBMITTED or DISPUTED contract state');
  if (!contract.escrow_external_ref || contract.escrow_external_ref !== input.escrowRef) {
    throw problem('CONTRACT_ESCROW_REFERENCE_MISMATCH', 'settlement escrow reference must match the immutable contract reference');
  }

  // A contract status alone is not an acceptance or adjudication decision.
  // Require durable, version-bound evidence before creating any financial Outbox command.
  if (contract.status === 'SUBMITTED') {
    const accepted = await client.query(
      "SELECT 1 FROM social.deliveries WHERE world_id=$1 AND contract_id=$2 AND version=$3 AND status='ACCEPTED' LIMIT 1",
      [contract.world_id, contract.contract_id, contract.current_version],
    );
    if (accepted.rowCount !== 1) {
      throw problem('CONTRACT_ACCEPTANCE_DECISION_REQUIRED', 'settlement requires an accepted delivery for the current contract version');
    }
  } else {
    const resolved = await client.query(
      "SELECT 1 FROM social.disputes WHERE world_id=$1 AND contract_id=$2 AND version=$3 AND status='RESOLVED' AND resolution IS NOT NULL AND resolved_by_entity_id IS NOT NULL LIMIT 1",
      [contract.world_id, contract.contract_id, contract.current_version],
    );
    if (resolved.rowCount !== 1) {
      throw problem('CONTRACT_DISPUTE_RESOLUTION_REQUIRED', 'disputed settlement requires a persisted resolution for the current contract version');
    }
  }

  const escrowSnapshot = validateEscrowSnapshot(input.escrowSnapshot, input.escrowRef);
  const amountMicroE = escrowSnapshot.balanceMicroE;
  assertAllocations(input.allocations, amountMicroE);
  const saga = createContractSettlementSaga({
    sagaId: input.sagaId, worldId: input.worldId, contractId: input.contractId,
    contractVersion: contract.current_version, businessAttemptId: input.businessAttemptId,
    settlementRequest: {
      principal_ref: input.principalRef,
      payload: {
        contract_ref: input.contractRef,
        amount_micro_e: amountMicroE,
        escrow_ref: escrowSnapshot.escrowRef,
        expected_balance_micro_e: escrowSnapshot.balanceMicroE,
        expected_resource_version: escrowSnapshot.authorityVersion,
        balance_receipt_ref: escrowSnapshot.receiptRef,
        balance_observed_at: escrowSnapshot.observedAt,
        allocations: input.allocations,
      },
    },
  });
  return prepareSagaIntent(client, saga);
}

async function loadSaga(client, { worldId, sagaId, kind }) {
  const result = await client.query(
    'SELECT * FROM social.cross_product_sagas WHERE world_id=$1 AND saga_id=$2 FOR UPDATE',
    [worldId, sagaId],
  );
  if (result.rowCount !== 1) throw problem('SAGA_NOT_FOUND', 'Saga not found', 404);
  const row = result.rows[0];
  const snapshot = typeof row.saga_snapshot === 'string' ? JSON.parse(row.saga_snapshot) : row.saga_snapshot;
  if (snapshot.kind !== kind) throw problem('SAGA_KIND_MISMATCH', 'Saga kind does not match requested transition');
  return { row, snapshot };
}

async function queueActivationCompensation(client, row, snapshot, reason) {
  const compensating = requestActivationCompensation(snapshot, reason);
  const command = buildFinancialCommand(compensating);
  const updated = await client.query(
    'UPDATE social.cross_product_sagas SET state=$3,compensation_operation_key=$4,saga_snapshot=$5::jsonb,version=version+1,updated_at=now() WHERE world_id=$1 AND saga_id=$2 RETURNING *',
    [row.world_id,row.saga_id,compensating.state,compensating.compensation_operation_key,JSON.stringify(compensating)],
  );
  const outbox = await client.query(
    'INSERT INTO social.cross_product_outbox (world_id,saga_id,business_attempt_id,operation_key,payload_digest,command_snapshot) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (world_id,operation_key) DO NOTHING RETURNING *',
    [compensating.world_id,compensating.saga_id,compensating.business_attempt_id,command.operation_key,command.payload_digest,JSON.stringify(command)],
  );
  return { saga: updated.rows[0], outbox: outbox.rows[0] ?? null, compensationRequired: true };
}

/** Commit ACTIVE only after a confirmed KB success and a fresh eligibility check. */
export async function commitContractActivation(client, { worldId, sagaId }) {
  const { row, snapshot } = await loadSaga(client, { worldId, sagaId, kind: SagaKind.CONTRACT_ACTIVATION });
  if (snapshot.state !== SagaState.REMOTE_SUCCEEDED || snapshot.primary_result?.status !== 'SUCCEEDED') {
    throw problem('REMOTE_FUNDING_NOT_CONFIRMED', 'contract cannot become ACTIVE before confirmed escrow funding');
  }
  const contract = await lockContractVersion(client, { worldId, contractId: snapshot.contract_id });
  const eligible = contract.status === 'PROPOSED'
    && contract.current_version === snapshot.contract_version
    && hasCriteria(contract.acceptance_criteria)
    && await acceptanceCount(client, contract) === 2;
  if (!eligible) {
    return queueActivationCompensation(client, row, snapshot, 'contract no longer eligible for ACTIVE commit after confirmed funding');
  }
  const escrowRef = snapshot.primary_result.result_ref;
  nonEmpty(escrowRef, 'primary_result.result_ref');
  await client.query(
    "UPDATE social.contracts SET status='ACTIVE',escrow_external_ref=$3,activated_at=COALESCE(activated_at,now()) WHERE world_id=$1 AND contract_id=$2 AND status='PROPOSED' AND current_version=$4",
    [worldId,snapshot.contract_id,escrowRef,snapshot.contract_version],
  );
  const completed = await markPersistedSagaLocalTransitionCommitted(client, { worldId, sagaId, localContractState: 'ACTIVE' });
  return { saga: completed, contractState: 'ACTIVE', escrowExternalRef: escrowRef, compensationRequired: false };
}

/** Settlement is forward-only after remote success; this never refunds a distribution. */
export async function commitContractSettlement(client, { worldId, sagaId }) {
  const { snapshot } = await loadSaga(client, { worldId, sagaId, kind: SagaKind.CONTRACT_SETTLEMENT });
  if (snapshot.state !== SagaState.REMOTE_SUCCEEDED || snapshot.primary_result?.status !== 'SUCCEEDED') {
    throw problem('REMOTE_SETTLEMENT_NOT_CONFIRMED', 'contract cannot become SETTLED before confirmed remote distribution');
  }
  const contract = await lockContractVersion(client, { worldId, contractId: snapshot.contract_id });
  if (!['SUBMITTED','DISPUTED'].includes(contract.status) || contract.current_version !== snapshot.contract_version) {
    throw problem('SETTLEMENT_FORWARD_RECOVERY_REQUIRED', 'remote distribution succeeded but local contract state needs forward reconciliation');
  }
  await client.query(
    "UPDATE social.contracts SET status='SETTLED',settled_at=COALESCE(settled_at,now()) WHERE world_id=$1 AND contract_id=$2 AND status IN ('SUBMITTED','DISPUTED') AND current_version=$3",
    [worldId,snapshot.contract_id,snapshot.contract_version],
  );
  const completed = await markPersistedSagaLocalTransitionCommitted(client, { worldId, sagaId, localContractState: 'SETTLED' });
  return { saga: completed, contractState: 'SETTLED' };
}
