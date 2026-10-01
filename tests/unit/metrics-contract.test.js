import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORBIDDEN_HIGH_CARDINALITY_LABELS,
  METRICS_CONTRACT,
  assertMetricLabels,
  metricLabelCardinality,
  validateMetricsContract,
} from '../../src/observability/metrics_contract.js';

const EXPECTED_NAMES = [
  'newhumans_runtime_turn_total',
  'newhumans_runtime_wake_delay_seconds',
  'newhumans_runtime_budget_rejection_total',
  'newhumans_gateway_request_total',
  'newhumans_gateway_request_duration_seconds',
  'newhumans_gateway_failure_total',
  'newhumans_gateway_cost_microe',
  'newhumans_kb_bridge_request_total',
  'newhumans_kb_bridge_request_duration_seconds',
  'newhumans_kb_retrieval_quality_total',
  'newhumans_social_operation_total',
  'newhumans_social_operation_duration_seconds',
];

test('metrics contract has stable names and counter/histogram coverage for each required domain', () => {
  assert.deepEqual(METRICS_CONTRACT.map(({ name }) => name), EXPECTED_NAMES);
  assert.equal(validateMetricsContract(), true);
  for (const domain of ['runtime', 'gateway', 'kb', 'social']) {
    const types = new Set(METRICS_CONTRACT.filter((metric) => metric.domain === domain).map((metric) => metric.type));
    assert.deepEqual([...types].sort(), ['counter', 'histogram']);
  }
});

test('every label has finite enumerated values and bounded cardinality', () => {
  for (const metric of METRICS_CONTRACT) {
    assert.ok(metricLabelCardinality(metric) <= 32, metric.name);
    for (const [label, values] of Object.entries(metric.labels)) {
      assert.ok(values.length > 0, `${metric.name}.${label}`);
      assert.equal(new Set(values).size, values.length, `${metric.name}.${label}`);
      assert.ok(!label.endsWith('_id'), `${metric.name}.${label}`);
    }
  }
});

test('entity_id and action_id are explicitly forbidden high-cardinality labels', () => {
  assert.ok(FORBIDDEN_HIGH_CARDINALITY_LABELS.includes('entity_id'));
  assert.ok(FORBIDDEN_HIGH_CARDINALITY_LABELS.includes('action_id'));

  assert.throws(
    () => assertMetricLabels('newhumans_gateway_request_total', { adapter_kind: 'CLOUD', outcome: 'SUCCESS', entity_id: 'entity-1' }),
    (error) => error.code === 'METRIC_DYNAMIC_LABEL_FORBIDDEN',
  );
  assert.throws(
    () => assertMetricLabels('newhumans_runtime_turn_total', { trigger: 'WAKE', outcome: 'COMPLETED', action_id: 'action-1' }),
    (error) => error.code === 'METRIC_DYNAMIC_LABEL_FORBIDDEN',
  );
});

test('runtime observations reject unknown dynamic labels, unbounded values, and missing labels', () => {
  assert.equal(assertMetricLabels('newhumans_gateway_request_total', { adapter_kind: 'LOCAL', outcome: 'SUCCESS' }), true);
  assert.throws(
    () => assertMetricLabels('newhumans_gateway_request_total', { adapter_kind: 'LOCAL', outcome: 'SUCCESS', provider_model: 'model-123' }),
    (error) => error.code === 'METRIC_LABEL_UNKNOWN',
  );
  assert.throws(
    () => assertMetricLabels('newhumans_gateway_request_total', { adapter_kind: 'LOCAL', outcome: 'provider-specific-error-92381' }),
    (error) => error.code === 'METRIC_LABEL_VALUE_UNBOUNDED',
  );
  assert.throws(
    () => assertMetricLabels('newhumans_gateway_request_total', { adapter_kind: 'LOCAL' }),
    (error) => error.code === 'METRIC_LABEL_MISSING',
  );
});

test('contract validation rejects newly introduced id labels even if their value set is finite', () => {
  const invalid = [{
    domain: 'runtime',
    name: 'newhumans_runtime_invalid_total',
    type: 'counter',
    unit: 'event',
    description: 'invalid fixture',
    labels: { entity_id: ['fixed-for-test'] },
  }];
  assert.throws(() => validateMetricsContract(invalid), (error) => error.code === 'METRIC_DYNAMIC_LABEL_FORBIDDEN');
});
