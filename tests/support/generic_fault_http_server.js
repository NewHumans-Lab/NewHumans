import net from 'node:net';

const SUPPORTED_FAULTS = new Set(['ok', 'timeout', 'disconnect', '429', '500', 'duplicate', 'malformed']);

function assertDelay(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function encodeJson(value) {
  return JSON.stringify(value);
}

function httpResponse(statusLine, body, headers = {}) {
  const payload = Buffer.from(body, 'utf8');
  const lines = [
    statusLine,
    `Content-Length: ${payload.length}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ];
  return Buffer.concat([Buffer.from(lines.join('\r\n'), 'utf8'), payload]);
}

function parseRequestHead(rawHead) {
  const [requestLine, ...headerLines] = rawHead.split('\r\n');
  const [method, target, protocol] = requestLine.split(' ');
  if (!method || !target || !protocol) throw new Error('invalid request line');

  const headers = {};
  for (const line of headerLines) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { method, target, protocol, headers };
}

function requestFault(target) {
  const url = new URL(target, 'http://fault.test');
  const prefix = '/fault/';
  if (!url.pathname.startsWith(prefix)) return { fault: 'ok', url };
  return { fault: decodeURIComponent(url.pathname.slice(prefix.length)), url };
}

export async function startGenericFaultHttpServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const timeoutMs = assertDelay(options.timeoutMs ?? 250, 'timeoutMs');
  const rateLimitRetryAfter = String(options.rateLimitRetryAfter ?? '1');
  const rateLimitBody = options.rateLimitBody ?? { error: 'rate_limited' };
  const internalErrorBody = options.internalErrorBody ?? { error: 'internal_error' };
  const duplicateBody = String(options.duplicateBody ?? 'duplicate-response');
  const malformedPayload = String(options.malformedPayload ?? 'NOT-HTTP\r\nContent-Length: nope\r\n\r\n');
  const requests = [];
  const sockets = new Set();
  const timers = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    let input = Buffer.alloc(0);
    let handled = false;

    const cleanup = () => sockets.delete(socket);
    socket.once('close', cleanup);
    socket.once('error', () => {});

    socket.on('data', (chunk) => {
      if (handled) return;
      input = Buffer.concat([input, chunk]);
      const headerEnd = input.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      handled = true;

      let parsed;
      try {
        parsed = parseRequestHead(input.subarray(0, headerEnd).toString('utf8'));
      } catch {
        socket.end(httpResponse('HTTP/1.1 400 Bad Request', encodeJson({ error: 'bad_request' }), {
          'Content-Type': 'application/json',
          Connection: 'close',
        }));
        return;
      }

      const { fault, url } = requestFault(parsed.target);
      requests.push({
        method: parsed.method,
        target: parsed.target,
        path: url.pathname,
        headers: parsed.headers,
        receivedAt: Date.now(),
      });

      if (!SUPPORTED_FAULTS.has(fault)) {
        socket.end(httpResponse('HTTP/1.1 404 Not Found', encodeJson({ error: 'unknown_fault', fault }), {
          'Content-Type': 'application/json',
          Connection: 'close',
        }));
        return;
      }

      if (fault === 'timeout') {
        const requestedDelay = url.searchParams.has('ms') ? Number(url.searchParams.get('ms')) : timeoutMs;
        const delay = Number.isInteger(requestedDelay) && requestedDelay > 0 ? requestedDelay : timeoutMs;
        const timer = setTimeout(() => {
          timers.delete(timer);
          socket.destroy();
        }, delay);
        timers.add(timer);
        return;
      }

      if (fault === 'disconnect') {
        socket.destroy();
        return;
      }

      if (fault === '429') {
        socket.end(httpResponse('HTTP/1.1 429 Too Many Requests', encodeJson(rateLimitBody), {
          'Content-Type': 'application/json',
          'Retry-After': rateLimitRetryAfter,
          Connection: 'close',
        }));
        return;
      }

      if (fault === '500') {
        socket.end(httpResponse('HTTP/1.1 500 Internal Server Error', encodeJson(internalErrorBody), {
          'Content-Type': 'application/json',
          Connection: 'close',
        }));
        return;
      }

      if (fault === 'duplicate') {
        const first = httpResponse('HTTP/1.1 200 OK', duplicateBody, {
          'Content-Type': 'text/plain; charset=utf-8',
          Connection: 'keep-alive',
          'X-Mock-Fault': 'duplicate',
        });
        const second = httpResponse('HTTP/1.1 200 OK', duplicateBody, {
          'Content-Type': 'text/plain; charset=utf-8',
          Connection: 'close',
          'X-Mock-Fault': 'duplicate',
        });
        socket.end(Buffer.concat([first, second]));
        return;
      }

      if (fault === 'malformed') {
        socket.end(malformedPayload);
        return;
      }

      socket.end(httpResponse('HTTP/1.1 200 OK', encodeJson({ ok: true }), {
        'Content-Type': 'application/json',
        Connection: 'close',
      }));
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port: options.port ?? 0 });
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fault server did not bind a TCP address');
  const originHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const origin = `http://${originHost}:${address.port}`;

  return {
    origin,
    address: { host: address.address, port: address.port },
    requests,
    url(fault = 'ok', params = {}) {
      if (!SUPPORTED_FAULTS.has(fault)) throw new RangeError(`unsupported fault: ${fault}`);
      const url = new URL(fault === 'ok' ? '/ok' : `/fault/${fault}`, origin);
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
      return url.toString();
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
