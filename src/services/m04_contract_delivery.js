function problem(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw problem('INVALID_CONTRACT_INPUT', field + ' must be a non-empty string', 400);
  }
  return value.trim();
}

function jsonObject(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw problem('INVALID_CONTRACT_INPUT', field + ' is required', 400);
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw problem('INVALID_CONTRACT_INPUT', field + ' must be a JSON object', 400);
  }
  return value;
}

async function lockContract(client, { worldId, contractId }) {
  const result = await client.query(
    'SELECT contract_id,world_id,status,current_version,employer_entity_id,contractor_entity_id FROM social.contracts WHERE world_id=$1 AND contract_id=$2 FOR UPDATE',
    [worldId,contractId],
  );
  if (result.rowCount !== 1) throw problem('CONTRACT_NOT_FOUND', 'contract not found', 404);
  return result.rows[0];
}

function assertVersion(contract, expectedVersion) {
  if (!Number.isInteger(expectedVersion) || expectedVersion !== contract.current_version) {
    throw problem('STALE_VERSION', 'expectedVersion must match the current contract version', 409);
  }
}

function assertParty(contract, actorEntityId) {
  if (![contract.employer_entity_id,contract.contractor_entity_id].includes(actorEntityId)) {
    throw problem('FORBIDDEN', 'only a contract party may perform this operation', 403);
  }
}

export async function submitDelivery(client, input) {
  const worldId=requiredString(input.worldId,'worldId');
  const contractId=requiredString(input.contractId,'contractId');
  const actorEntityId=requiredString(input.actorEntityId,'actorEntityId');
  const artifactRef=requiredString(input.artifactRef,'artifactRef');
  const idempotencyKey=requiredString(input.idempotencyKey,'idempotencyKey');
  if (input.milestoneId !== undefined && input.milestoneId !== null) {
    throw problem('MILESTONE_WORKFLOW_NOT_SUPPORTED', 'milestone-specific submissions require the milestone workflow slice', 409);
  }
  const contract=await lockContract(client,{worldId,contractId});
  if (actorEntityId !== contract.contractor_entity_id) throw problem('FORBIDDEN', 'only the contractor may submit delivery', 403);
  assertVersion(contract,input.expectedVersion);

  const existing=await client.query(
    'SELECT * FROM social.deliveries WHERE world_id=$1 AND contract_id=$2 AND idempotency_key=$3',
    [worldId,contractId,idempotencyKey],
  );
  if (existing.rowCount === 1) {
    const row=existing.rows[0];
    if (row.version !== contract.current_version || row.submitted_by_entity_id !== actorEntityId || row.artifact_ref !== artifactRef || row.milestone_id !== null) {
      throw problem('IDEMPOTENCY_CONFLICT', 'delivery idempotency key was already used with different content', 409);
    }
    return {delivery:row,contractStatus:contract.status,replayed:true};
  }
  if (contract.status !== 'ACTIVE') throw problem('CONTRACT_NOT_DELIVERABLE', 'delivery requires an ACTIVE contract', 409);

  const seq=await client.query(
    'SELECT COALESCE(MAX(submission_no),0)::integer+1 AS next_no FROM social.deliveries WHERE world_id=$1 AND contract_id=$2 AND version=$3',
    [worldId,contractId,contract.current_version],
  );
  const inserted=await client.query(
    "INSERT INTO social.deliveries (world_id,contract_id,version,submission_no,submitted_by_entity_id,artifact_ref,idempotency_key,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'SUBMITTED') RETURNING *",
    [worldId,contractId,contract.current_version,seq.rows[0].next_no,actorEntityId,artifactRef,idempotencyKey],
  );
  await client.query("UPDATE social.contracts SET status='SUBMITTED' WHERE world_id=$1 AND contract_id=$2",[worldId,contractId]);
  return {delivery:inserted.rows[0],contractStatus:'SUBMITTED',replayed:false};
}

export async function reviewDelivery(client, input) {
  const worldId=requiredString(input.worldId,'worldId');
  const contractId=requiredString(input.contractId,'contractId');
  const deliveryId=requiredString(input.deliveryId,'deliveryId');
  const actorEntityId=requiredString(input.actorEntityId,'actorEntityId');
  const decision=requiredString(input.decision,'decision').toUpperCase();
  if (!['ACCEPT','REWORK'].includes(decision)) throw problem('INVALID_REVIEW_DECISION', 'decision must be ACCEPT or REWORK', 400);
  const reviewEvidence=jsonObject(input.reviewEvidence,'reviewEvidence');
  const contract=await lockContract(client,{worldId,contractId});
  if (actorEntityId !== contract.employer_entity_id) throw problem('FORBIDDEN', 'only the employer may review delivery', 403);
  if (contract.status !== 'SUBMITTED') throw problem('CONTRACT_NOT_REVIEWABLE', 'review requires a SUBMITTED contract', 409);
  assertVersion(contract,input.expectedVersion);

  const deliveryResult=await client.query(
    'SELECT d.*,v.rework_limit FROM social.deliveries d JOIN social.contract_versions v ON v.world_id=d.world_id AND v.contract_id=d.contract_id AND v.version=d.version WHERE d.world_id=$1 AND d.contract_id=$2 AND d.delivery_id=$3 FOR UPDATE OF d',
    [worldId,contractId,deliveryId],
  );
  if (deliveryResult.rowCount !== 1) throw problem('DELIVERY_NOT_FOUND', 'delivery not found', 404);
  const delivery=deliveryResult.rows[0];
  if (delivery.version !== contract.current_version) throw problem('STALE_VERSION', 'delivery is not for the current contract version', 409);
  if (delivery.status !== 'SUBMITTED') throw problem('DELIVERY_ALREADY_REVIEWED', 'only a SUBMITTED delivery can be reviewed', 409);
  const reviewNote=input.reviewNote == null ? null : requiredString(input.reviewNote,'reviewNote');

  if (decision === 'REWORK') {
    const rejected=await client.query(
      "SELECT count(*)::integer AS n FROM social.deliveries WHERE world_id=$1 AND contract_id=$2 AND version=$3 AND status='REJECTED'",
      [worldId,contractId,contract.current_version],
    );
    if (rejected.rows[0].n >= delivery.rework_limit) {
      throw problem('REWORK_LIMIT_EXCEEDED', 'contract version has exhausted its permitted rework count', 409);
    }
    if (!reviewNote) throw problem('REVIEW_NOTE_REQUIRED', 'rework requires a specific review note', 400);
  }

  const status=decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
  const updated=await client.query(
    'UPDATE social.deliveries SET status=$4,review_note=$5,review_evidence=$6::jsonb,reviewed_at=now() WHERE world_id=$1 AND contract_id=$2 AND delivery_id=$3 RETURNING *',
    [worldId,contractId,deliveryId,status,reviewNote,JSON.stringify(reviewEvidence)],
  );
  if (decision === 'REWORK') {
    await client.query("UPDATE social.contracts SET status='ACTIVE' WHERE world_id=$1 AND contract_id=$2",[worldId,contractId]);
  }
  return {delivery:updated.rows[0],decision,contractStatus:decision === 'REWORK' ? 'ACTIVE' : 'SUBMITTED'};
}

export async function raiseContractDispute(client, input) {
  const worldId=requiredString(input.worldId,'worldId');
  const contractId=requiredString(input.contractId,'contractId');
  const actorEntityId=requiredString(input.actorEntityId,'actorEntityId');
  const reason=requiredString(input.reason,'reason');
  const evidence=jsonObject(input.evidence,'evidence');
  const contract=await lockContract(client,{worldId,contractId});
  assertParty(contract,actorEntityId);
  if (contract.status !== 'SUBMITTED') throw problem('CONTRACT_NOT_DISPUTABLE', 'dispute requires a SUBMITTED contract', 409);
  assertVersion(contract,input.expectedVersion);

  let deliveryId=null;
  if (input.deliveryId != null) {
    deliveryId=requiredString(input.deliveryId,'deliveryId');
    const delivery=await client.query(
      "SELECT delivery_id,status FROM social.deliveries WHERE world_id=$1 AND contract_id=$2 AND version=$3 AND delivery_id=$4 FOR UPDATE",
      [worldId,contractId,contract.current_version,deliveryId],
    );
    if (delivery.rowCount !== 1) throw problem('DELIVERY_NOT_FOUND', 'disputed delivery must belong to the current contract version', 404);
    if (!['SUBMITTED','ACCEPTED','REJECTED'].includes(delivery.rows[0].status)) {
      throw problem('DELIVERY_NOT_DISPUTABLE', 'delivery status cannot be disputed', 409);
    }
  }

  const inserted=await client.query(
    "INSERT INTO social.disputes (world_id,contract_id,version,delivery_id,raised_by_entity_id,status,reason,evidence) VALUES ($1,$2,$3,$4,$5,'OPEN',$6,$7::jsonb) RETURNING *",
    [worldId,contractId,contract.current_version,deliveryId,actorEntityId,reason,JSON.stringify(evidence)],
  );
  if (deliveryId) {
    await client.query("UPDATE social.deliveries SET status='DISPUTED' WHERE world_id=$1 AND contract_id=$2 AND delivery_id=$3",[worldId,contractId,deliveryId]);
  }
  await client.query("UPDATE social.contracts SET status='DISPUTED' WHERE world_id=$1 AND contract_id=$2",[worldId,contractId]);
  return {dispute:inserted.rows[0],contractStatus:'DISPUTED'};
}

const adjudicatorAuthorizations = new WeakMap();

/** Call before opening the database transaction; returns a process-local authorization capability. */
export async function verifyContractAdjudicator(adjudicatorPort, input) {
  const worldId = requiredString(input.worldId, 'worldId');
  const contractId = requiredString(input.contractId, 'contractId');
  const disputeId = requiredString(input.disputeId, 'disputeId');
  const actorEntityId = requiredString(input.actorEntityId, 'actorEntityId');
  if (!adjudicatorPort || typeof adjudicatorPort.verifyAdjudicator !== 'function') throw problem('ADJUDICATOR_VERIFIER_UNAVAILABLE', 'trusted adjudicator verifier is required', 503);
  const verified = await adjudicatorPort.verifyAdjudicator({ worldId, contractId, disputeId, expectedVersion: input.expectedVersion, actorEntityId });
  if (!verified || verified.authorized !== true || typeof verified.adjudicatorEntityId !== 'string' || !verified.adjudicatorEntityId.trim()) throw problem('FORBIDDEN_ADJUDICATOR', 'trusted authority did not authorize this adjudicator', 403);
  const capability = Object.freeze({});
  adjudicatorAuthorizations.set(capability, { worldId, contractId, disputeId, actorEntityId, expectedVersion: input.expectedVersion, adjudicatorEntityId: verified.adjudicatorEntityId });
  return capability;
}

export async function adjudicateContractDispute(client, input) {
  const worldId = requiredString(input.worldId, 'worldId');
  const contractId = requiredString(input.contractId, 'contractId');
  const disputeId = requiredString(input.disputeId, 'disputeId');
  const actorEntityId = requiredString(input.actorEntityId, 'actorEntityId');
  const outcome = requiredString(input.outcome, 'outcome').toUpperCase();
  if (!['UPHOLD_CLAIM', 'REJECT_CLAIM'].includes(outcome)) throw problem('INVALID_ADJUDICATION_OUTCOME', 'outcome must be UPHOLD_CLAIM or REJECT_CLAIM', 400);
  const resolution = jsonObject(input.resolution, 'resolution', { required: true });
  if (!Object.keys(resolution).length) throw problem('RESOLUTION_REQUIRED', 'resolution must contain a structured explanation', 400);
  const authorization = input.adjudicatorAuthorization;
  const verified = authorization && adjudicatorAuthorizations.get(authorization);
  if (!verified || verified.worldId !== worldId || verified.contractId !== contractId || verified.disputeId !== disputeId || verified.actorEntityId !== actorEntityId || verified.expectedVersion !== input.expectedVersion) throw problem('FORBIDDEN_ADJUDICATOR', 'a matching pre-verified adjudicator authorization is required', 403);
  const contract = await lockContract(client, { worldId, contractId });
  if (contract.status !== 'DISPUTED') throw problem('CONTRACT_NOT_DISPUTED', 'adjudication requires a DISPUTED contract', 409);
  assertVersion(contract, input.expectedVersion);
  const found = await client.query('SELECT * FROM social.disputes WHERE world_id=$1 AND contract_id=$2 AND dispute_id=$3 FOR UPDATE', [worldId, contractId, disputeId]);
  if (found.rowCount !== 1) throw problem('DISPUTE_NOT_FOUND', 'dispute not found for this contract and world', 404);
  const dispute = found.rows[0];
  if (dispute.version !== contract.current_version) throw problem('STALE_VERSION', 'dispute is not bound to the current contract version', 409);
  if (!['OPEN', 'UNDER_REVIEW'].includes(dispute.status)) throw problem('DISPUTE_ALREADY_RESOLVED', 'only OPEN or UNDER_REVIEW disputes may be resolved', 409);
  const stored = { outcome, details: resolution };
  const updated = await client.query("UPDATE social.disputes SET status='RESOLVED', resolution=$4::jsonb, resolved_by_entity_id=$5, resolved_at=now() WHERE world_id=$1 AND contract_id=$2 AND dispute_id=$3 AND status IN ('OPEN','UNDER_REVIEW') RETURNING *", [worldId, contractId, disputeId, JSON.stringify(stored), verified.adjudicatorEntityId]);
  if (updated.rowCount !== 1) throw problem('DISPUTE_ALREADY_RESOLVED', 'dispute changed while adjudication was in progress', 409);
  return { dispute: updated.rows[0], contractStatus: 'DISPUTED', outcome };
}
