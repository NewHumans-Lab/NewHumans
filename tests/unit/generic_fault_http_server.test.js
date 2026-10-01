import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { startGenericFaultHttpServer } from '../support/generic_fault_http_server.js';

async function withServer(options, fn) {
  const server = await startGenericFaultHttpServer(options);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

async function rawGet(server, path) {
  const socket = net.createConnection({ host: server.address.host, port: server.address.port });
  let output = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => { output += chunk; });
  await once(socket, 'connect');
  socket.write(`GET ${path} HTTP/1.1\r\nHost: fault.test\r\nConnection: close\r\n\r\n`);
  await once(socket, 'close');
  return output;
}

test('timeout fault keeps the connection open without a response until configured expiry', async () => {
  await withServer({ timeoutMs: 80 }, async (server) => {
    const socket = net.createConnection({ host: server.address.host, port: server.address.port });
    let output = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { output += chunk; });
    await once(socket, 'connect');
    socket.write('GET /fault/timeout HTTP/1.1\r\nHost: fault.test\r\n\r\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(output, '');
    assert.equal(socket.destroyed, false);
    await once(socket, 'close');
    assert.equal(output, '');
  });
});

test('disconnect fault closes the transport without an HTTP response', async () => {
  await withServer({}, async (server) => {
    assert.equal(await rawGet(server, '/fault/disconnect'), '');
  });
});

test('429 fault returns a configurable rate-limit response', async () => {
  await withServer({ rateLimitRetryAfter: 7, rateLimitBody: { error: 'slow_down' } }, async (server) => {
    const response = await fetch(server.url('429'));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '7');
    assert.deepEqual(await response.json(), { error: 'slow_down' });
  });
});

test('500 fault returns a configurable internal-error response', async () => {
  await withServer({ internalErrorBody: { error: 'upstream_failed' } }, async (server) => {
    const response = await fetch(server.url('500'));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'upstream_failed' });
  });
});

test('duplicate fault emits two complete HTTP responses on one connection', async () => {
  await withServer({ duplicateBody: 'same-body' }, async (server) => {
    const output = await rawGet(server, '/fault/duplicate');
    assert.equal((output.match(/HTTP\/1\.1 200 OK/g) ?? []).length, 2);
    assert.equal((output.match(/same-body/g) ?? []).length, 2);
  });
});

test('malformed fault emits a configurable invalid HTTP payload', async () => {
  const malformedPayload = 'BROKEN RESPONSE\r\n\r\n';
  await withServer({ malformedPayload }, async (server) => {
    assert.equal(await rawGet(server, '/fault/malformed'), malformedPayload);
  });
});

test('one server instance can switch faults per request and records requests for assertions', async () => {
  await withServer({}, async (server) => {
    const ok = await fetch(server.url('ok'));
    const failure = await fetch(server.url('500'));
    assert.equal(ok.status, 200);
    assert.equal(failure.status, 500);
    assert.deepEqual(server.requests.map((request) => request.path), ['/ok', '/fault/500']);
    assert.throws(() => server.url('not-a-fault'), /unsupported fault/);
  });
});
