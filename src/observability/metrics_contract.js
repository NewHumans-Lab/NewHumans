const MAX_LABEL_COMBINATIONS_PER_METRIC = 32;

export const FORBIDDEN_HIGH_CARDINALITY_LABELS = Object.freeze([
  'entity_id',
  'action_id',
  'turn_id',
  'event_id',
  'request_id',
  'message_id',
  'contract_id',
  'organization_id',
  'world_id',
  'user_id',
  'agent_id',
]);

function freezeMetric(metric) {
  const labels = Object.freeze(Object.fromEntries(
    Object.entries(metric.labels).map(([name, values]) => [name, Object.freeze([...values])]),
  ));
  return Object.freeze({ ...metric, labels });
}

export const METRICS_CONTRACT = Object.freeze([
  freezeMetric({
    domain: 'runtime',
    name: 'newhumans_runtime_turn_total',
    type: 'counter',
    unit: 'turn',
    description: 'Runtime turns grouped only by bounded trigger and terminal outcome.',
    labels: {
      trigger: ['WAKE', 'AUTONOMOUS_TURN', 'MANUAL'],
      outcome: ['COMPLETED', 'FAILED', 'BLOCKED', 'SKIPPED'],
    },
  }),
  freezeMetric({
    domain: 'runtime',
    name: 'newhumans_runtime_wake_delay_seconds',
    type: 'histogram',
    unit: 'seconds',
    description: 'Delay from scheduled runtime wake time to claim/start.',
    labels: {
      trigger: ['WAKE', 'AUTONOMOUS_TURN'],
      outcome: ['STARTED', 'MISSED', 'BLOCKED'],
    },
  }),
  freezeMetric({
    domain: 'runtime',
    name: 'newhumans_runtime_budget_rejection_total',
    type: 'counter',
    unit: 'rejection',
    description: 'Runtime work rejected by bounded economic or policy budget gates.',
    labels: {
      reason: ['NONPOSITIVE_BALANCE', 'TASK_SEEK_THRESHOLD', 'DAILY_FEE_UNAVAILABLE', 'USAGE_BUDGET_EXCEEDED'],
    },
  }),
  freezeMetric({
    domain: 'gateway',
    name: 'newhumans_gateway_request_total',
    type: 'counter',
    unit: 'request',
    description: 'Model/tool gateway calls grouped by adapter class and bounded outcome.',
    labels: {
      adapter_kind: ['CLOUD', 'LOCAL'],
      outcome: ['SUCCESS', 'FAILURE', 'OUTCOME_UNKNOWN', 'REJECTED'],
    },
  }),
  freezeMetric({
    domain: 'gateway',
    name: 'newhumans_gateway_request_duration_seconds',
    type: 'histogram',
    unit: 'seconds',
    description: 'End-to-end gateway call latency.',
    labels: {
      adapter_kind: ['CLOUD', 'LOCAL'],
      outcome: ['SUCCESS', 'FAILURE', 'OUTCOME_UNKNOWN', 'REJECTED'],
    },
  }),
  freezeMetric({
    domain: 'gateway',
    name: 'newhumans_gateway_failure_total',
    type: 'counter',
    unit: 'failure',
    description: 'Gateway failures classified into a finite operational taxonomy.',
    labels: {
      failure_class: ['AUTH', 'RATE_LIMIT', 'TRANSPORT', 'TIMEOUT', 'INVALID_RESPONSE', 'USAGE_UNAVAILABLE', 'POLICY', 'PROVIDER'],
    },
  }),
  freezeMetric({
    domain: 'gateway',
    name: 'newhumans_gateway_cost_microe',
    type: 'histogram',
    unit: 'microe',
    description: 'Per-call charged internal cost distribution without provider or entity labels.',
    labels: {
      adapter_kind: ['CLOUD', 'LOCAL'],
    },
  }),
  freezeMetric({
    domain: 'kb',
    name: 'newhumans_kb_bridge_request_total',
    type: 'counter',
    unit: 'request',
    description: 'Requests across the NewHumans to Knowledge Ball boundary; does not define Knowledge Ball internals.',
    labels: {
      operation: ['CONTEXT_RETRIEVE', 'EVENT_SYNC', 'STATUS'],
      outcome: ['SUCCESS', 'MISS', 'FAILURE', 'UNAVAILABLE'],
    },
  }),
  freezeMetric({
    domain: 'kb',
    name: 'newhumans_kb_bridge_request_duration_seconds',
    type: 'histogram',
    unit: 'seconds',
    description: 'Latency across the Knowledge Ball integration boundary.',
    labels: {
      operation: ['CONTEXT_RETRIEVE', 'EVENT_SYNC', 'STATUS'],
      outcome: ['SUCCESS', 'MISS', 'FAILURE', 'UNAVAILABLE'],
    },
  }),
  freezeMetric({
    domain: 'kb',
    name: 'newhumans_kb_retrieval_quality_total',
    type: 'counter',
    unit: 'retrieval',
    description: 'Bounded retrieval quality outcomes needed for observability without query or entity labels.',
    labels: {
      result: ['HIT', 'MISS', 'ERROR'],
    },
  }),
  freezeMetric({
    domain: 'social',
    name: 'newhumans_social_operation_total',
    type: 'counter',
    unit: 'operation',
    description: 'M04 social operations grouped by bounded operation class and outcome.',
    labels: {
      operation: ['MESSAGE_SUBMIT', 'MESSAGE_DELIVER', 'CONTRACT_TRANSITION', 'PROJECT_MUTATION', 'ORGANIZATION_MUTATION'],
      outcome: ['SUCCESS', 'REJECTED', 'FAILURE', 'OUTCOME_UNKNOWN'],
    },
  }),
  freezeMetric({
    domain: 'social',
    name: 'newhumans_social_operation_duration_seconds',
    type: 'histogram',
    unit: 'seconds',
    description: 'Latency of M04 social operations using only bounded operation classes.',
    labels: {
      operation: ['MESSAGE_SUBMIT', 'MESSAGE_DELIVER', 'CONTRACT_TRANSITION', 'PROJECT_MUTATION', 'ORGANIZATION_MUTATION'],
      outcome: ['SUCCESS', 'REJECTED', 'FAILURE', 'OUTCOME_UNKNOWN'],
    },
  }),
]);

const METRIC_BY_NAME = new Map(METRICS_CONTRACT.map((metric) => [metric.name, metric]));
const FORBIDDEN_LABEL_SET = new Set(FORBIDDEN_HIGH_CARDINALITY_LABELS);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function metricLabelCardinality(metric) {
  return Object.values(metric.labels).reduce((product, values) => product * values.length, 1);
}

export function validateMetricsContract(metrics = METRICS_CONTRACT) {
  const names = new Set();
  const domains = new Map();
  for (const metric of metrics) {
    if (!/^[a-z][a-z0-9_]*$/.test(metric.name)) fail('METRIC_NAME_INVALID', `invalid metric name: ${metric.name}`);
    if (names.has(metric.name)) fail('METRIC_NAME_DUPLICATE', `duplicate metric name: ${metric.name}`);
    names.add(metric.name);
    if (!['counter', 'histogram'].includes(metric.type)) fail('METRIC_TYPE_INVALID', `invalid metric type: ${metric.name}`);
    if (metric.type === 'counter' && !metric.name.endsWith('_total')) fail('METRIC_COUNTER_NAME_INVALID', `counter must end in _total: ${metric.name}`);
    if (metric.type === 'histogram' && metric.name.endsWith('_total')) fail('METRIC_HISTOGRAM_NAME_INVALID', `histogram must not end in _total: ${metric.name}`);
    if (!['runtime', 'gateway', 'kb', 'social'].includes(metric.domain)) fail('METRIC_DOMAIN_INVALID', `invalid metric domain: ${metric.name}`);

    const domainTypes = domains.get(metric.domain) ?? new Set();
    domainTypes.add(metric.type);
    domains.set(metric.domain, domainTypes);

    for (const [label, values] of Object.entries(metric.labels)) {
      if (FORBIDDEN_LABEL_SET.has(label) || label.endsWith('_id')) fail('METRIC_DYNAMIC_LABEL_FORBIDDEN', `high-cardinality label forbidden: ${label}`);
      if (!Array.isArray(values) || values.length === 0 || new Set(values).size !== values.length) fail('METRIC_LABEL_VALUES_INVALID', `label must have unique finite values: ${metric.name}.${label}`);
      if (values.some((value) => typeof value !== 'string' || value.length === 0)) fail('METRIC_LABEL_VALUES_INVALID', `label values must be non-empty strings: ${metric.name}.${label}`);
    }
    if (metricLabelCardinality(metric) > MAX_LABEL_COMBINATIONS_PER_METRIC) fail('METRIC_LABEL_CARDINALITY_EXCEEDED', `label cardinality exceeds ${MAX_LABEL_COMBINATIONS_PER_METRIC}: ${metric.name}`);
  }
  for (const domain of ['runtime', 'gateway', 'kb', 'social']) {
    const types = domains.get(domain);
    if (!types?.has('counter') || !types?.has('histogram')) fail('METRIC_DOMAIN_COVERAGE_MISSING', `${domain} requires counter and histogram coverage`);
  }
  return true;
}

export function assertMetricLabels(metricName, labels) {
  const metric = METRIC_BY_NAME.get(metricName);
  if (!metric) fail('METRIC_UNKNOWN', `unknown metric: ${metricName}`);
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) fail('METRIC_LABELS_INVALID', `labels must be an object: ${metricName}`);

  const expected = Object.keys(metric.labels);
  const actual = Object.keys(labels);
  for (const label of actual) {
    if (FORBIDDEN_LABEL_SET.has(label) || label.endsWith('_id')) fail('METRIC_DYNAMIC_LABEL_FORBIDDEN', `high-cardinality label forbidden: ${label}`);
    if (!Object.hasOwn(metric.labels, label)) fail('METRIC_LABEL_UNKNOWN', `unknown label for ${metricName}: ${label}`);
  }
  for (const label of expected) {
    if (!Object.hasOwn(labels, label)) fail('METRIC_LABEL_MISSING', `missing label for ${metricName}: ${label}`);
    if (!metric.labels[label].includes(labels[label])) fail('METRIC_LABEL_VALUE_UNBOUNDED', `unbounded label value for ${metricName}.${label}: ${labels[label]}`);
  }
  return true;
}

validateMetricsContract();
