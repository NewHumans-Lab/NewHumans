import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCorrelationContext,
  getCorrelationContext,
  requireCorrelationContext,
  runWithCorrelationContext,
} from '../../src/shared/correlation-context.js';

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test('root context generates isolated request/action/correlation ids', () => {
  const first = createCorrelationContext();
  const second = createCorrelationContext();

  for (const key of ['requestId', 'actionId', 'correlationId']) {
    assert.match(first[key], /^[0-9a-f-]{36}$/);
    assert.notEqual(first[key], second[key]);
  }
  assert.equal(getCorrelationContext(), null);
});

test('concurrent async requests never leak correlation ids', async () => {
  const aReady = deferred();
  const bReady = deferred();

  const a = runWithCorrelationContext(
    { requestId: 'request-a', actionId: 'action-a', correlationId: 'correlation-a' },
    async () => {
      aReady.resolve();
      await bReady.promise;
      await Promise.resolve();
      return getCorrelationContext();
    },
  );

  const b = runWithCorrelationContext(
    { requestId: 'request-b', actionId: 'action-b', correlationId: 'correlation-b' },
    async () => {
      bReady.resolve();
      await aReady.promise;
      await Promise.resolve();
      return getCorrelationContext();
    },
  );

  assert.deepEqual(await a, {
    requestId: 'request-a',
    actionId: 'action-a',
    correlationId: 'correlation-a',
  });
  assert.deepEqual(await b, {
    requestId: 'request-b',
    actionId: 'action-b',
    correlationId: 'correlation-b',
  });
  assert.equal(getCorrelationContext(), null);
});

test('nested tasks inherit parent context and restore it after overrides', async () => {
  await runWithCorrelationContext(
    { requestId: 'request-parent', actionId: 'action-parent', correlationId: 'correlation-parent' },
    async (parent) => {
      assert.equal(requireCorrelationContext(), parent);

      const child = await runWithCorrelationContext({ actionId: 'action-child' }, async () => {
        await Promise.resolve();
        return requireCorrelationContext();
      });

      assert.deepEqual(child, {
        requestId: 'request-parent',
        actionId: 'action-child',
        correlationId: 'correlation-parent',
      });
      assert.equal(requireCorrelationContext(), parent);
    },
  );

  assert.throws(
    () => requireCorrelationContext(),
    (error) => error.code === 'CORRELATION_CONTEXT_REQUIRED',
  );
});

test('invalid explicit ids fail before entering async context', () => {
  assert.throws(() => createCorrelationContext({ requestId: '' }), TypeError);
  assert.throws(() => createCorrelationContext({ actionId: null }), TypeError);
  assert.throws(() => runWithCorrelationContext({}, null), TypeError);
});
