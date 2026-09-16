import { buildCommandEnvelope, toRunCommand } from '../shared/contracts.js';

export function actorFromRequest(req) {
  return req.headers['x-nh-actor-id'];
}

export function idempotencyKeyFromRequest(req) {
  return req.headers['idempotency-key'];
}

export function trustedWorldFromRequest(req) {
  const value = req.headers['x-nh-world-id'];
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(new Error('trusted x-nh-world-id context is required'), { code: 'UNAUTHENTICATED_WORLD_CONTEXT', status: 401 });
  }
  return value;
}

export function rejectClientWorld(data) {
  if (Object.prototype.hasOwnProperty.call(data, 'worldId') || Object.prototype.hasOwnProperty.call(data, 'world_id')) {
    throw Object.assign(new Error('world is trusted server context and must not be supplied in command payload'), { code: 'UNTRUSTED_CONTEXT_FIELD', status: 400 });
  }
}

export function canonicalCommandFromRequest(req, data, commandType) {
  rejectClientWorld(data);
  const worldId = trustedWorldFromRequest(req);
  const actorEntityId = actorFromRequest(req);
  const idempotencyKey = idempotencyKeyFromRequest(req);
  const envelope = buildCommandEnvelope({ commandType, idempotencyKey, payload: data });
  return {
    envelope,
    run: {
      ...toRunCommand(envelope, { actorEntityId, worldId }),
      // Keep the trusted world in the persisted action hash for compatibility with
      // pre-P1.4 action hashes that included worldId in the transport body.
      payload: { worldId, ...data },
    },
    data: { worldId, ...data },
  };
}
