export const KB_CAPABILITIES = Object.freeze(['economy', 'memory', 'knowledge']);

export const KB_READINESS = Object.freeze({
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
});

function freezeCapability(value) {
  return Object.freeze({
    reported: value.reported,
    read_ready: value.read_ready,
    write_ready: value.write_ready,
    reason: value.reason,
  });
}

function normalizeCapability(value) {
  if (value === true) {
    return freezeCapability({ reported: true, read_ready: true, write_ready: true, reason: null });
  }
  if (value === false || value == null) {
    return freezeCapability({
      reported: value !== undefined,
      read_ready: false,
      write_ready: false,
      reason: value === undefined ? 'NOT_REPORTED' : null,
    });
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('KB capability readiness must be a boolean or object');
  }

  const readReady = value.read_ready === true;
  const writeReady = value.write_ready === true;
  const reason = value.reason == null ? null : String(value.reason);
  return freezeCapability({
    reported: value.reported !== false,
    read_ready: readReady,
    write_ready: writeReady,
    reason,
  });
}

export function buildKbReadiness(capabilities = {}) {
  if (capabilities == null || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new TypeError('KB readiness capabilities must be an object');
  }

  const normalized = {};
  for (const capability of KB_CAPABILITIES) {
    normalized[capability] = normalizeCapability(capabilities[capability]);
  }

  const slots = KB_CAPABILITIES.flatMap((capability) => [
    normalized[capability].read_ready,
    normalized[capability].write_ready,
  ]);
  const readyCount = slots.filter(Boolean).length;
  const overall = readyCount === slots.length
    ? KB_READINESS.READY
    : readyCount === 0
      ? KB_READINESS.UNAVAILABLE
      : KB_READINESS.DEGRADED;

  return Object.freeze({
    schema_version: 'nh.kb.readiness.v1',
    overall,
    capabilities: Object.freeze(normalized),
  });
}

function normalizeRequiredCapabilities(requiredCapabilities) {
  const values = typeof requiredCapabilities === 'string'
    ? [requiredCapabilities]
    : requiredCapabilities;
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('At least one KB capability is required');
  }
  const unique = [];
  for (const capability of values) {
    if (!KB_CAPABILITIES.includes(capability)) {
      throw new RangeError(`Unknown KB capability: ${capability}`);
    }
    if (!unique.includes(capability)) unique.push(capability);
  }
  return unique;
}

function assertReport(report) {
  if (!report || report.schema_version !== 'nh.kb.readiness.v1' || !report.capabilities) {
    throw new TypeError('Invalid KB readiness report');
  }
  return report;
}

export function evaluateKbCapabilityAccess(report, requiredCapabilities, access = 'read') {
  assertReport(report);
  if (access !== 'read' && access !== 'write') {
    throw new RangeError(`Unsupported KB access mode: ${access}`);
  }
  const required = normalizeRequiredCapabilities(requiredCapabilities);
  const readinessField = access === 'write' ? 'write_ready' : 'read_ready';
  const blocked_capabilities = required.filter(
    (capability) => report.capabilities[capability]?.[readinessField] !== true,
  );
  return Object.freeze({
    allowed: blocked_capabilities.length === 0,
    access,
    required_capabilities: Object.freeze([...required]),
    blocked_capabilities: Object.freeze(blocked_capabilities),
  });
}

export class KbCapabilityWriteBlockedError extends Error {
  constructor(decision) {
    super(`KB write blocked by unavailable capabilities: ${decision.blocked_capabilities.join(', ')}`);
    this.name = 'KbCapabilityWriteBlockedError';
    this.blocked_capabilities = decision.blocked_capabilities;
    this.required_capabilities = decision.required_capabilities;
  }
}

export function assertKbWriteReady(report, requiredCapabilities) {
  const decision = evaluateKbCapabilityAccess(report, requiredCapabilities, 'write');
  if (!decision.allowed) throw new KbCapabilityWriteBlockedError(decision);
  return decision;
}
