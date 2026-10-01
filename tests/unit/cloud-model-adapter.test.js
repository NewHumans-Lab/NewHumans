import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_MODEL_ADAPTER_CONTRACT_VERSION,
  CloudModelAdapterError,
  assertCloudModelAdapter,
  createJsonHttpCloudModelAdapter,
} from '../../src/services/providers/cloud_model_adapter.js';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('provider adapter contract requires send/cancel/inspect/usage', () => {
  assert.throws(
    () => assertCloudModelAdapter({ send() {}, cancel() {}, inspect() {} }),
    (error) => error instanceof CloudModelAdapterError && error.code === 'INVALID_ADAPTER',
  );
});

test('HTTP 200 standardizes send/cancel/inspect/usage without changing requested model identity', async () => {
  const calls = [];
  const responses = [
    jsonResponse({ status: 'SUCCEEDED', model_reference: 'provider-reported-model', usage: { input_tokens: 4, output_tokens: 3 } }, { headers: { 'x-request-id': 'provider-1' } }),
    jsonResponse({ request_id: 'provider-1', status: 'CANCEL_REQUESTED' }),
    jsonResponse({ request_id: 'provider-1', status: 'SUCCEEDED', model_reference: 'provider-reported-model' }),
    jsonResponse({ request_id: 'provider-1', status: 'FINAL', usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }),
  ];
  const adapter = createJsonHttpCloudModelAdapter({
    baseUrl: 'https://mock.models.test/v1/',
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), options });
      return responses.shift();
    },
  });

  const sent = await adapter.send({
    executionId: 'execution-1',
    attemptId: 'attempt-1',
    modelReference: 'route-selected-model-v17',
    payload: { messages: [{ role: 'user', content: 'hello' }] },
    idempotencyKey: 'idem-1',
  });
  assert.equal(sent.contractVersion, CLOUD_MODEL_ADAPTER_CONTRACT_VERSION);
  assert.equal(sent.operation, 'send');
  assert.equal(sent.providerRequestId, 'provider-1');
  assert.equal(sent.requestedModelReference, 'route-selected-model-v17');
  assert.equal(sent.providerModelReference, 'provider-reported-model');
  assert.deepEqual(sent.usage, {
    inputTokens: 4,
    outputTokens: 3,
    totalTokens: 7,
    raw: { input_tokens: 4, output_tokens: 3 },
  });
  const sentBody = JSON.parse(calls[0].options.body);
  assert.equal(sentBody.model_reference, 'route-selected-model-v17');
  assert.equal(calls[0].options.headers['idempotency-key'], 'idem-1');

  const cancelled = await adapter.cancel({ providerRequestId: 'provider-1' });
  const inspected = await adapter.inspect({ providerRequestId: 'provider-1' });
  const usage = await adapter.usage({ providerRequestId: 'provider-1' });
  assert.equal(cancelled.operation, 'cancel');
  assert.equal(cancelled.status, 'CANCEL_REQUESTED');
  assert.equal(inspected.operation, 'inspect');
  assert.equal(inspected.providerModelReference, 'provider-reported-model');
  assert.equal(usage.operation, 'usage');
  assert.equal(usage.usage.totalTokens, 7);
  assert.deepEqual(calls.map((call) => call.options.method), ['POST', 'POST', 'GET', 'GET']);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://mock.models.test/v1/requests',
    'https://mock.models.test/v1/requests/provider-1/cancel',
    'https://mock.models.test/v1/requests/provider-1',
    'https://mock.models.test/v1/requests/provider-1/usage',
  ]);
});

test('HTTP 429 is a normalized retryable rate-limit failure', async () => {
  const adapter = createJsonHttpCloudModelAdapter({
    baseUrl: 'https://mock.models.test/',
    fetchImpl: async () => jsonResponse({ error: 'rate limited', request_id: 'provider-429' }, { status: 429, headers: { 'retry-after': '2' } }),
  });
  await assert.rejects(
    adapter.send({ executionId: 'e1', attemptId: 'a1', modelReference: 'model-a', payload: {} }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_RATE_LIMITED');
      assert.equal(error.operation, 'send');
      assert.equal(error.httpStatus, 429);
      assert.equal(error.retryable, true);
      assert.equal(error.outcomeUnknown, false);
      assert.equal(error.retryAfterMs, 2000);
      assert.equal(error.providerRequestId, 'provider-429');
      return true;
    },
  );
});

test('HTTP 500 is a normalized retryable confirmed provider failure', async () => {
  const adapter = createJsonHttpCloudModelAdapter({
    baseUrl: 'https://mock.models.test/',
    fetchImpl: async () => jsonResponse({ error: 'internal', request_id: 'provider-500' }, { status: 500 }),
  });
  await assert.rejects(
    adapter.inspect({ providerRequestId: 'provider-500' }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.operation, 'inspect');
      assert.equal(error.httpStatus, 500);
      assert.equal(error.retryable, true);
      assert.equal(error.outcomeUnknown, false);
      return true;
    },
  );
});

test('timeout is outcome-unknown and is not auto-retryable at the adapter layer', async () => {
  const adapter = createJsonHttpCloudModelAdapter({
    baseUrl: 'https://mock.models.test/',
    timeoutMs: 5,
    fetchImpl: async () => {
      throw Object.assign(new Error('mock timeout'), { name: 'TimeoutError' });
    },
  });
  await assert.rejects(
    adapter.cancel({ providerRequestId: 'provider-timeout' }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_TIMEOUT');
      assert.equal(error.operation, 'cancel');
      assert.equal(error.retryable, false);
      assert.equal(error.outcomeUnknown, true);
      return true;
    },
  );
});

test('malformed HTTP 200 response is outcome-unknown instead of fabricated success', async () => {
  const adapter = createJsonHttpCloudModelAdapter({
    baseUrl: 'https://mock.models.test/',
    fetchImpl: async () => new Response('{not-json', { status: 200, headers: { 'x-request-id': 'provider-malformed' } }),
  });
  await assert.rejects(
    adapter.usage({ providerRequestId: 'provider-malformed' }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_MALFORMED_RESPONSE');
      assert.equal(error.operation, 'usage');
      assert.equal(error.httpStatus, 200);
      assert.equal(error.retryable, false);
      assert.equal(error.outcomeUnknown, true);
      return true;
    },
  );
});

test('cloud adapter transport cannot redirect an operation to another origin', async () => {
  const adapter = createJsonHttpCloudModelAdapter({
    baseUrl: 'https://mock.models.test/',
    routes: { inspect: () => 'https://other-origin.test/request' },
    fetchImpl: async () => jsonResponse({ request_id: 'never-called' }),
  });
  await assert.rejects(
    adapter.inspect({ providerRequestId: 'provider-1' }),
    (error) => error.code === 'INVALID_ADAPTER_CONFIG',
  );
});
