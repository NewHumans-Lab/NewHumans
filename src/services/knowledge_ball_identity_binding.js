import { withTransaction } from '../db.js';
import { appendEvent } from './core.js';

function problem(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}
function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw problem('INVALID_IDENTITY_BINDING_INPUT', field + ' must be a non-empty string', 400);
  }
  return value.trim();
}

async function authorizeBindingActor(client, { worldId, actorEntityId, entityId }) {
  const result=await client.query(
    "SELECT entity_id,identity_status FROM core.entities WHERE world_id=$1 AND entity_id = ANY($2::uuid[])",
    [worldId,[actorEntityId,entityId]],
  );
  const expectedEntities = actorEntityId === entityId ? 1 : 2;
  if (result.rowCount !== expectedEntities || result.rows.some(row=>row.identity_status !== 'ACTIVE')) {
    throw problem('IDENTITY_BINDING_ENTITY_INACTIVE', 'actor and target Entity must both be active in the trusted world', 403);
  }
  if (actorEntityId === entityId) return;

  const grant=await client.query(
    "SELECT grant_id FROM core.capability_grants WHERE world_id=$1 AND grantor_entity_id=$2 AND grantee_entity_id=$3 AND actions @> ARRAY['identity.bind_knowledge_ball']::text[] AND revoked_at IS NULL AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now()) LIMIT 1",
    [worldId,entityId,actorEntityId],
  );
  if (grant.rowCount !== 1) throw problem('FORBIDDEN', 'binding another Entity requires an active identity.bind_knowledge_ball grant from that Entity', 403);
}

async function lockBindingAggregate(client, { worldId, entityId }) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[worldId+':'+entityId+':knowledge-ball-binding']);
}

async function assertNoActiveBinding(client, { worldId, entityId }) {
  const existing=await client.query(
    "SELECT binding_id FROM core.entity_provider_bindings WHERE world_id=$1 AND entity_id=$2 AND provider='knowledge-ball' AND status='ACTIVE' FOR UPDATE",
    [worldId,entityId],
  );
  if (existing.rowCount) throw problem('KB_PRINCIPAL_ALREADY_BOUND', 'revoke the active binding before linking a different Knowledge Ball principal', 409);
}

/**
 * Bind an Entity only after the trusted Knowledge Ball identity port verifies a proof.
 * The external verification call is deliberately outside any PostgreSQL transaction.
 *
 * identityPort.verifyBindingProof({ worldId, entityId, proof }) must verify the proof
 * against Knowledge Ball authority and return its canonical principal_ref and audit ref.
 * The client cannot choose the persisted principal_ref.
 */
export async function bindKnowledgeBallPrincipal(pool, input, { identityPort } = {}) {
  const worldId=requiredString(input.worldId,'worldId');
  const actorEntityId=requiredString(input.actorEntityId,'actorEntityId');
  const entityId=requiredString(input.entityId,'entityId');
  const proof=requiredString(input.proof,'proof');
  if (Object.prototype.hasOwnProperty.call(input,'principalRef') || Object.prototype.hasOwnProperty.call(input,'principal_ref')) {
    throw problem('UNTRUSTED_CONTEXT_FIELD', 'principal_ref is returned by the trusted Knowledge Ball identity port and cannot be supplied by the client', 400);
  }
  if (!identityPort || typeof identityPort.verifyBindingProof !== 'function') {
    throw problem('KB_IDENTITY_PROVIDER_UNAVAILABLE', 'trusted Knowledge Ball identity verification is not configured', 503);
  }

  await withTransaction(pool,async client=>{
    await lockBindingAggregate(client,{worldId,entityId});
    await authorizeBindingActor(client,{worldId,actorEntityId,entityId});
    await assertNoActiveBinding(client,{worldId,entityId});
  });

  const verified=await identityPort.verifyBindingProof({worldId,entityId,proof});
  if (!verified || verified.provider !== 'knowledge-ball'
      || typeof verified.principalRef !== 'string' || verified.principalRef.trim() === ''
      || typeof verified.verificationRef !== 'string' || verified.verificationRef.trim() === ''
      || !Number.isFinite(Date.parse(verified.verifiedAt))) {
    throw problem('KB_IDENTITY_PROOF_INVALID', 'Knowledge Ball identity provider returned invalid verification evidence', 502);
  }

  return withTransaction(pool,async client=>{
    await lockBindingAggregate(client,{worldId,entityId});
    await authorizeBindingActor(client,{worldId,actorEntityId,entityId});
    await assertNoActiveBinding(client,{worldId,entityId});
    const versionResult=await client.query(
      "SELECT COALESCE(MAX(binding_version),0)::integer+1 AS next_version FROM core.entity_provider_bindings WHERE world_id=$1 AND entity_id=$2 AND provider='knowledge-ball'",
      [worldId,entityId],
    );
    const bindingVersion=versionResult.rows[0].next_version;
    const inserted=await client.query(
      "INSERT INTO core.entity_provider_bindings (world_id,entity_id,provider,principal_ref,binding_version,status,verified_by_entity_id,verification_ref,verified_at) VALUES ($1,$2,'knowledge-ball',$3,$4,'ACTIVE',$5,$6,$7::timestamptz) RETURNING binding_id,binding_version,status,verified_at",
      [worldId,entityId,verified.principalRef.trim(),bindingVersion,actorEntityId,verified.verificationRef.trim(),new Date(verified.verifiedAt).toISOString()],
    );
    await appendEvent(client,{
      worldId,aggregateType:'ENTITY',aggregateId:entityId,eventType:'KNOWLEDGE_BALL_PRINCIPAL_BOUND',
      actorEntityId, payload:{bindingId:inserted.rows[0].binding_id,provider:'knowledge-ball',bindingVersion,verificationRef:verified.verificationRef.trim()},
    });
    return {bindingId:inserted.rows[0].binding_id,entityId,worldId,provider:'knowledge-ball',bindingVersion,status:'ACTIVE',verifiedAt:inserted.rows[0].verified_at};
  });
}

/** Resolve the active, auditable binding for internal service use; never infer from names or emails. */
export async function resolveKnowledgeBallPrincipal(client, { worldId, entityId }) {
  requiredString(worldId,'worldId'); requiredString(entityId,'entityId');
  const result=await client.query(
    "SELECT b.binding_id,b.provider,b.principal_ref,b.binding_version,b.verified_at FROM core.entity_provider_bindings b JOIN core.entities e ON e.world_id=b.world_id AND e.entity_id=b.entity_id WHERE b.world_id=$1 AND b.entity_id=$2 AND b.status='ACTIVE' AND e.identity_status='ACTIVE'",
    [worldId,entityId],
  );
  if (result.rowCount !== 1) throw problem('KB_PRINCIPAL_BINDING_REQUIRED', 'Entity has no active verified Knowledge Ball principal binding', 409);
  return {
    bindingId:result.rows[0].binding_id,
    provider:result.rows[0].provider,
    principalRef:result.rows[0].principal_ref,
    bindingVersion:result.rows[0].binding_version,
    verifiedAt:result.rows[0].verified_at,
  };
}

export async function revokeKnowledgeBallPrincipalBinding(pool, input) {
  const worldId=requiredString(input.worldId,'worldId');
  const actorEntityId=requiredString(input.actorEntityId,'actorEntityId');
  const entityId=requiredString(input.entityId,'entityId');
  const reason=requiredString(input.reason,'reason');
  return withTransaction(pool,async client=>{
    await lockBindingAggregate(client,{worldId,entityId});
    await authorizeBindingActor(client,{worldId,actorEntityId,entityId});
    const active=await client.query(
      "SELECT binding_id,binding_version FROM core.entity_provider_bindings WHERE world_id=$1 AND entity_id=$2 AND provider='knowledge-ball' AND status='ACTIVE' FOR UPDATE",
      [worldId,entityId],
    );
    if (active.rowCount !== 1) throw problem('KB_PRINCIPAL_BINDING_NOT_FOUND', 'no active Knowledge Ball principal binding exists', 404);
    await client.query(
      "UPDATE core.entity_provider_bindings SET status='REVOKED',revoked_by_entity_id=$3,revoked_at=now(),revoke_reason=$4 WHERE world_id=$1 AND binding_id=$2",
      [worldId,active.rows[0].binding_id,actorEntityId,reason],
    );
    await appendEvent(client,{
      worldId,aggregateType:'ENTITY',aggregateId:entityId,eventType:'KNOWLEDGE_BALL_PRINCIPAL_BINDING_REVOKED',
      actorEntityId,payload:{bindingId:active.rows[0].binding_id,bindingVersion:active.rows[0].binding_version,reason},
    });
    return {bindingId:active.rows[0].binding_id,entityId,worldId,status:'REVOKED',bindingVersion:active.rows[0].binding_version};
  });
}
