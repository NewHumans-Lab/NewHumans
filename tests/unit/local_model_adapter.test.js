import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  LOCAL_MODEL_ADAPTER_CONTRACT_VERSION,
  LocalModelAdapterError,
  createOpenAICompatibleLocalModelAdapter,
} from '../../src/services/providers/local_model_adapter.js';

async function startMockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function baseRequest(overrides = {}) {
  return {
    executionId: 'execution-local-1',
    attemptId: 'attempt-local-1',
    modelReference: 'local/test-model',
    idempotencyKey: 'local-idempotency-1',
    payload: {
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 32,
    },
    ...overrides,
  };
}

test('local OpenAI-compatible adapter exposes the standard model adapter operations', () => {
  const adapter = createOpenAICompatibleLocalModelAdapter({ baseUrl: 'http://127.0.0.1:12345/' });
  for (const operation of ['send', 'cancel', 'inspect', 'usage']) {
    assert.equal(typeof adapter[operation], 'function');
  }
});

test('send uses a local OpenAI-compatible endpoint and returns the normalized adapter envelope', async (t) => {
  let observed = null;
  const mock = await startMockServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = {
      method: request.method,
      url: request.url,
      idempotencyKey: request.headers['idempotency-key'],
      executionId: request.headers['x-newhumans-execution-id'],
      attemptId: request.headers['x-newhumans-attempt-id'],
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'provider-local-1' });
    response.end(JSON.stringify({
      id: 'provider-body-id',
      model: 'local/test-model@fixture',
      choices: [{ message: { role: 'assistant', content: 'pong' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }));
  });
  t.after(() => mock.close());

  const adapter = createOpenAICompatibleLocalModelAdapter({ baseUrl: mock.baseUrl, timeoutMs: 1_000 });
  const result = await adapter.send(baseRequest());

  assert.deepEqual(Object.keys(result), [
    'contractVersion',
    'operation',
    'ok',
    'httpStatus',
    'providerRequestId',
    'status',
    'requestedModelReference',
    'providerModelReference',
    'usage',
    'data',
  ]);
  assert.equal(result.contractVersion, LOCAL_MODEL_ADAPTER_CONTRACT_VERSION);
  assert.equal(result.operation, 'send');
  assert.equal(result.ok, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.providerRequestId, 'provider-local-1');
  assert.equal(result.requestedModelReference, 'local/test-model');
  assert.equal(result.providerModelReference, 'local/test-model@fixture');
  assert.deepEqual(result.usage, {
    inputTokens: 4,
    outputTokens: 2,
    totalTokens: 6,
    raw: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  });
  assert.equal(result.data.choices[0].message.content, 'pong');
  assert.deepEqual(observed, {
    method: 'POST',
    url: '/v1/chat/completions',
    idempotencyKey: 'local-idempotency-1',
    executionId: 'execution-local-1',
    attemptId: 'attempt-local-1',
    body: {
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 32,
      model: 'local/test-model',
    },
  });
});

test('connection loss is normalized as an outcome-unknown transport error', async () => {
  const mock = await startMockServer((_request, response) => response.end());
  const baseUrl = mock.baseUrl;
  await mock.close();

  const adapter = createOpenAICompatibleLocalModelAdapter({ baseUrl, timeoutMs: 100 });
  await assert.rejects(
    () => adapter.send(baseRequest()),
    (error) => {
      assert.ok(error instanceof LocalModelAdapterError);
      assert.equal(error.code, 'PROVIDER_TRANSPORT_ERROR');
      assert.equal(error.operation, 'send');
      assert.equal(error.retryable, false);
      assert.equal(error.outcomeUnknown, true);
      return true;
    },
  );
});

test('slow local response is aborted and normalized as PROVIDER_TIMEOUT', async (t) => {
  const mock = await startMockServer(async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!response.destroyed) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'late-1', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }
  });
  t.after(() => mock.close());

  const adapter = createOpenAICompatibleLocalModelAdapter({ baseUrl: mock.baseUrl, timeoutMs: 20 });
  await assert.rejects(
    () => adapter.send(baseRequest()),
    (error) => {
      assert.ok(error instanceof LocalModelAdapterError);
      assert.equal(error.code, 'PROVIDER_TIMEOUT');
      assert.equal(error.operation, 'send');
      assert.equal(error.retryable, false);
      assert.equal(error.outcomeUnknown, true);
      return true;
    },
  );
});

test('successful response with missing usage preserves the standard envelope with usage=null', async (t) => {
  const mock = await startMockServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'provider-local-no-usage',
      model: 'local/test-model',
      choices: [{ message: { role: 'assistant', content: 'usage omitted' } }],
    }));
  });
  t.after(() => mock.close());

  const adapter = createOpenAICompatibleLocalModelAdapter({ baseUrl: mock.baseUrl });
  const result = await adapter.send(baseRequest());
  assert.equal(result.providerRequestId, 'provider-local-no-usage');
  assert.equal(result.usage, null);
  assert.equal(result.data.choices[0].message.content, 'usage omitted');
});

test('unsupported local cancellation/inspect/usage remain present but fail explicitly', async () => {
  const adapter = createOpenAICompatibleLocalModelAdapter({ baseUrl: 'http://127.0.0.1:12345/' });
  for (const operation of ['cancel', 'inspect', 'usage']) {
    await assert.rejects(
      () => adapter[operation]({ providerRequestId: 'provider-local-1' }),
      (error) => {
        assert.ok(error instanceof LocalModelAdapterError);
        assert.equal(error.code, 'ADAPTER_OPERATION_UNSUPPORTED');
        assert.equal(error.operation, operation);
        assert.equal(error.outcomeUnknown, false);
        return true;
      },
    );
  }
});
