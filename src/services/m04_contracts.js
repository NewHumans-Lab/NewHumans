function problem(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw problem('INVALID_CONTRACT_INPUT', field + ' must be a non-empty string', 400);
  }
  return value.trim();
}

function positivePrice(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw problem('INVALID_CONTRACT_INPUT', 'priceMicroE must be a non-negative integer string', 400);
  }
  return value;
}

function nonEmptyJson(value, field) {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)
      || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)) {
    throw problem('INVALID_CONTRACT_INPUT', field + ' must not be empty', 400);
  }
  return value;
}

async function assertParty(client, { worldId, contractId, actorEntityId }) {
  const result = await client.query(
    'SELECT contract_id,world_id,status,current_version,employer_entity_id,contractor_entity_id FROM social.contracts WHERE world_id=$1 AND contract_id=$2 FOR UPDATE',
    [worldId, contractId],
  );
  if (result.rowCount !== 1) throw problem('CONTRACT_NOT_FOUND', 'contract not found', 404);
  const contract = result.rows[0];
  if (![contract.employer_entity_id, contract.contractor_entity_id].includes(actorEntityId)) {
    throw problem('FORBIDDEN', 'only a contract party may change contract terms or accept a version', 403);
  }
  return contract;
}

function validateTerms(input) {
  return {
    scope: requiredString(input.scope, 'scope'),
    deliverables: nonEmptyJson(input.deliverables, 'deliverables'),
    acceptanceCriteria: nonEmptyJson(input.acceptanceCriteria, 'acceptanceCriteria'),
    priceMicroE: positivePrice(input.priceMicroE),
    startConditions: input.startConditions ?? {},
    deliveryDueAt: input.deliveryDueAt ?? null,
    acceptanceWindowSeconds: input.acceptanceWindowSeconds ?? 172800,
    reworkLimit: input.reworkLimit ?? 0,
    cancellationTerms: input.cancellationTerms ?? null,
    disputeProcedure: input.disputeProcedure ?? null,
    autoAcceptance: input.autoAcceptance ?? false,
    reasoningCostPayerEntityId: input.reasoningCostPayerEntityId ?? null,
    ruleVersion: requiredString(input.ruleVersion ?? 'nh.v3.0', 'ruleVersion'),
    changeSummary: input.changeSummary ?? '',
  };
}

async function insertVersion(client, { worldId, contractId, version, parentVersion, authorEntityId, terms }) {
  const result = await client.query(
    'INSERT INTO social.contract_versions (world_id,contract_id,version,parent_version,scope,deliverables,acceptance_criteria,price_micro_e,start_conditions,delivery_due_at,acceptance_window_seconds,rework_limit,cancellation_terms,dispute_procedure,auto_acceptance,reasoning_cost_payer_entity_id,rule_version,change_summary,author_entity_id) ' +
    'VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *',
    [worldId,contractId,version,parentVersion,terms.scope,JSON.stringify(terms.deliverables),JSON.stringify(terms.acceptanceCriteria),terms.priceMicroE,
      JSON.stringify(terms.startConditions),terms.deliveryDueAt,terms.acceptanceWindowSeconds,terms.reworkLimit,terms.cancellationTerms,
      terms.disputeProcedure,terms.autoAcceptance,terms.reasoningCostPayerEntityId,terms.ruleVersion,terms.changeSummary,authorEntityId],
  );
  return result.rows[0];
}

/**
 * Create a proposed contract and its first immutable version.
 * This function never reserves or moves funds; activation belongs to the M04↔KB Saga.
 */
export async function proposeContract(client, input) {
  const worldId = requiredString(input.worldId, 'worldId');
  const actorEntityId = requiredString(input.actorEntityId, 'actorEntityId');
  const employerEntityId = requiredString(input.employerEntityId, 'employerEntityId');
  const contractorEntityId = requiredString(input.contractorEntityId, 'contractorEntityId');
  if (employerEntityId === contractorEntityId) throw problem('INVALID_CONTRACT_INPUT', 'employer and contractor must differ', 400);
  if (actorEntityId !== employerEntityId) throw problem('FORBIDDEN', 'only the employer may create the initial proposal', 403);
  const terms = validateTerms(input);
  const parties = await client.query(
    'SELECT entity_id FROM core.entities WHERE world_id=$1 AND entity_id = ANY($2::uuid[])',
    [worldId,[employerEntityId,contractorEntityId]],
  );
  if (parties.rowCount !== 2) throw problem('CONTRACT_PARTY_NOT_FOUND', 'both contract parties must exist in the trusted world', 404);
  const created = await client.query(
    "INSERT INTO social.contracts (world_id,employer_entity_id,contractor_entity_id,status,current_version) VALUES ($1,$2,$3,'PROPOSED',0) RETURNING *",
    [worldId,employerEntityId,contractorEntityId],
  );
  const contract = created.rows[0];
  const version = await insertVersion(client,{worldId,contractId:contract.contract_id,version:1,parentVersion:null,authorEntityId:actorEntityId,terms});
  await client.query('UPDATE social.contracts SET current_version=1 WHERE world_id=$1 AND contract_id=$2',[worldId,contract.contract_id]);
  return {contractId:contract.contract_id,worldId,status:'PROPOSED',currentVersion:1,version};
}

/** Publish an immutable next version. Old acceptances remain historical and do not accept the new version. */
export async function publishContractVersion(client, input) {
  const worldId = requiredString(input.worldId, 'worldId');
  const actorEntityId = requiredString(input.actorEntityId, 'actorEntityId');
  const contractId = requiredString(input.contractId, 'contractId');
  const contract = await assertParty(client,{worldId,contractId,actorEntityId});
  if (contract.status !== 'PROPOSED') throw problem('CONTRACT_TERMS_LOCKED', 'contract terms may only be revised while PROPOSED');
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== contract.current_version) {
    throw problem('STALE_VERSION', 'expectedVersion must match the current contract version', 409);
  }
  const terms = validateTerms(input);
  const nextVersion = contract.current_version + 1;
  const version = await insertVersion(client,{worldId,contractId,version:nextVersion,parentVersion:contract.current_version,authorEntityId:actorEntityId,terms});
  await client.query(
    'UPDATE social.contract_acceptances SET invalidated_at=COALESCE(invalidated_at,now()) WHERE world_id=$1 AND contract_id=$2 AND version=$3 AND invalidated_at IS NULL',
    [worldId,contractId,contract.current_version],
  );
  await client.query('UPDATE social.contracts SET current_version=$3 WHERE world_id=$1 AND contract_id=$2',[worldId,contractId,nextVersion]);
  return {contractId,worldId,status:contract.status,currentVersion:nextVersion,version};
}

/** Record one party's explicit acceptance of the exact current version. No funds are moved. */
export async function acceptContractVersion(client, input) {
  const worldId = requiredString(input.worldId, 'worldId');
  const actorEntityId = requiredString(input.actorEntityId, 'actorEntityId');
  const contractId = requiredString(input.contractId, 'contractId');
  const idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey');
  const contract = await assertParty(client,{worldId,contractId,actorEntityId});
  if (contract.status !== 'PROPOSED') throw problem('CONTRACT_NOT_ACCEPTING', 'only a PROPOSED contract can accept terms');
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== contract.current_version) {
    throw problem('STALE_VERSION', 'expectedVersion must match the current contract version', 409);
  }
  const existing = await client.query(
    'SELECT * FROM social.contract_acceptances WHERE world_id=$1 AND contract_id=$2 AND version=$3 AND party_entity_id=$4 AND invalidated_at IS NULL',
    [worldId,contractId,contract.current_version,actorEntityId],
  );
  if (existing.rowCount === 1) return {contractId,version:contract.current_version,partyEntityId:actorEntityId,accepted:true,replayed:true,acceptance:existing.rows[0]};
  const result = await client.query(
    'INSERT INTO social.contract_acceptances (world_id,contract_id,version,party_entity_id,idempotency_key) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [worldId,contractId,contract.current_version,actorEntityId,idempotencyKey],
  );
  return {contractId,version:contract.current_version,partyEntityId:actorEntityId,accepted:true,replayed:false,acceptance:result.rows[0]};
}
