import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const commandSchema = JSON.parse(
  fs.readFileSync(new URL('../../schemas/command-envelope.schema.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateCommand = ajv.compile(commandSchema);

function invalidEnvelope() {
  const error = new Error('command envelope does not satisfy nh.v3.0');
  error.code = 'INVALID_COMMAND_ENVELOPE';
  error.status = 400;
  error.validationErrors = validateCommand.errors;
  return error;
}

export function assertCommandEnvelope(envelope) {
  if (!validateCommand(envelope)) throw invalidEnvelope();
  return envelope;
}

export function buildCommandEnvelope({
  worldId,
  commandType,
  idempotencyKey,
  payload = {},
  requestId,
  expectedVersion,
  onBehalfOf,
}) {
  const envelope = {
    schema_version: 'nh.v3.0',
    world_id: worldId,
    command_type: commandType,
    idempotency_key: idempotencyKey,
    payload,
  };
  if (requestId !== undefined) envelope.request_id = requestId;
  if (expectedVersion !== undefined) envelope.expected_version = expectedVersion;
  if (onBehalfOf !== undefined) envelope.on_behalf_of = onBehalfOf;
  return assertCommandEnvelope(envelope);
}

export function toRunCommand(envelope, actorEntityId) {
  assertCommandEnvelope(envelope);
  return {
    worldId: envelope.world_id,
    actorEntityId,
    actionType: envelope.command_type,
    idempotencyKey: envelope.idempotency_key,
    payload: envelope.payload,
  };
}
