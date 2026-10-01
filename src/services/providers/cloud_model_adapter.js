const OPERATIONS = Object.freeze(['send', 'cancel', 'inspect', 'usage']);

export const CLOUD_MODEL_ADAPTER_CONTRACT_VERSION = 'nh.m06.cloud-model-adapter.v1';
export const CLOUD_MODEL_ADAPTER_OPERATIONS = OPERATIONS;

export class CloudModelAdapterError extends Error {
  constructor(code, message, {
    operation = null,
    httpStatus = null,
    retryable = false,
    outcomeUnknown = false,
    retryAfterMs = null,
    providerRequestId = null,
    responseBody = null,
    cause = undefined,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CloudModelAdapterError';
    this.code = code;
    this.operation = operation;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.outcomeUnknown = outcomeUnknown;
    this.retryAfterMs = retryAfterMs;
    this.providerRequestId = providerRequestId;
    this.responseBody = responseBody;
  }
}

function adapterError(code, message, details) {
  return new CloudModelAdapterError(code, message, details);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw adapterError('INVALID_ADAPTER_INPUT', `${field} must be a non-empty string`);
  }
  return value;
}

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw adapterError('INVALID_ADAPTER_CONFIG', 'baseUrl must be an absolute URL');
  }
  if (url.protocol !== 'https:') throw adapterError('INVALID_ADAPTER_CONFIG', 'cloud model adapters require https');
  if (url.username || url.password || url.search || url.hash) {
    throw adapterError('INVALID_ADAPTER_CONFIG', 'baseUrl cannot contain credentials, query, or fragment');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function validateTimeoutMs(value) {
  if (!Number.isInteger(value) || value < 1 || value > 300_000) {
    throw adapterError('INVALID_ADAPTER_CONFIG', 'timeoutMs must be an integer from 1 to 300000');
  }
  return value;
}

function validateRoute(route, operation) {
  if (typeof route !== 'function') throw adapterError('INVALID_ADAPTER_CONFIG', `${operation} route must be a function`);
  return route;
}

function resolveRoute(baseUrl, routeValue, operation) {
  requireNonEmptyString(routeValue, `${operation} route`);
  let resolved;
  try {
    resolved = new URL(routeValue, baseUrl);
  } catch {
    throw adapterError('INVALID_ADAPTER_CONFIG', `${operation} route is not a valid URL path`);
  }
  if (resolved.origin !== baseUrl.origin) {
    throw adapterError('INVALID_ADAPTER_CONFIG', `${operation} route cannot change provider origin`);
  }
  return resolved;
}

function parseRetryAfter(value, nowMs = Date.now()) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, 3_600_000);
  const target = Date.parse(value);
  if (Number.isNaN(target)) return null;
  return Math.max(0, Math.min(target - nowMs, 3_600_000));
}

function providerRequestIdFrom(response, payload) {
  const headerId = response.headers?.get?.('x-request-id');
  const bodyId = payload?.provider_request_id ?? payload?.request_id ?? payload?.id;
  return typeof headerId === 'string' && headerId.length > 0
    ? headerId
    : typeof bodyId === 'string' && bodyId.length > 0
      ? bodyId
      : null;
}

function providerModelReferenceFrom(payload) {
  const value = payload?.model_reference ?? payload?.model;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeUsage(payload) {
  const source = payload?.usage;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const inputTokens = source.input_tokens ?? source.prompt_tokens ?? source.inputTokens;
  const outputTokens = source.output_tokens ?? source.completion_tokens ?? source.outputTokens;
  const totalTokens = source.total_tokens ?? source.totalTokens;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return { raw: source };
  if (!Number.isInteger(inputTokens) || inputTokens < 0 || !Number.isInteger(outputTokens) || outputTokens < 0) {
    throw adapterError('PROVIDER_MALFORMED_RESPONSE', 'provider usage token fields must be non-negative integers', { outcomeUnknown: true });
  }
  if (totalTokens !== undefined && (!Number.isInteger(totalTokens) || totalTokens < 0)) {
    throw adapterError('PROVIDER_MALFORMED_RESPONSE', 'provider total token usage must be a non-negative integer', { outcomeUnknown: true });
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens ?? inputTokens + outputTokens,
    raw: source,
  };
}

function responseEnvelope(operation, response, payload, { requestedModelReference = null } = {}) {
  const providerRequestId = providerRequestIdFrom(response, payload);
  if (!providerRequestId) {
    throw adapterError('PROVIDER_MALFORMED_RESPONSE', 'provider success response did not include a request identifier', {
      operation,
      httpStatus: response.status,
      outcomeUnknown: true,
      responseBody: payload,
    });
  }
  let usage = null;
  try {
    usage = normalizeUsage(payload);
  } catch (error) {
    if (error instanceof CloudModelAdapterError) {
      error.operation = operation;
      error.httpStatus = response.status;
      error.providerRequestId = providerRequestId;
      error.responseBody = payload;
    }
    throw error;
  }
  return {
    contractVersion: CLOUD_MODEL_ADAPTER_CONTRACT_VERSION,
    operation,
    ok: true,
    httpStatus: response.status,
    providerRequestId,
    status: typeof payload.status === 'string' ? payload.status : null,
    requestedModelReference,
    providerModelReference: providerModelReferenceFrom(payload),
    usage,
    data: payload,
  };
}

async function readJsonResponse(response, operation) {
  let text;
  try {
    text = await response.text();
  } catch (cause) {
    throw adapterError('PROVIDER_MALFORMED_RESPONSE', 'provider response body could not be read', {
      operation,
      httpStatus: response.status,
      outcomeUnknown: response.ok,
      cause,
    });
  }
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function classifyHttpFailure(operation, response, payload) {
  const providerRequestId = providerRequestIdFrom(response, payload);
  const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
  const common = {
    operation,
    httpStatus: response.status,
    providerRequestId,
    retryAfterMs,
    responseBody: payload,
  };
  if (response.status === 429) {
    return adapterError('PROVIDER_RATE_LIMITED', 'provider rate limited the request', { ...common, retryable: true });
  }
  if (response.status >= 500 && response.status <= 599) {
    return adapterError('PROVIDER_UNAVAILABLE', 'provider returned a server error', { ...common, retryable: true });
  }
  return adapterError('PROVIDER_HTTP_ERROR', `provider returned HTTP ${response.status}`, common);
}

export function assertCloudModelAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw adapterError('INVALID_ADAPTER', 'adapter must be an object');
  for (const operation of OPERATIONS) {
    if (typeof adapter[operation] !== 'function') {
      throw adapterError('INVALID_ADAPTER', `adapter.${operation} must be a function`);
    }
  }
  return adapter;
}

export class JsonHttpCloudModelAdapter {
  constructor({
    baseUrl,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
    routes = {},
  }) {
    if (typeof fetchImpl !== 'function') throw adapterError('INVALID_ADAPTER_CONFIG', 'fetchImpl must be a function');
    this.baseUrl = validateBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = validateTimeoutMs(timeoutMs);
    this.routes = {
      send: validateRoute(routes.send ?? (() => 'requests'), 'send'),
      cancel: validateRoute(routes.cancel ?? ((id) => `requests/${encodeURIComponent(id)}/cancel`), 'cancel'),
      inspect: validateRoute(routes.inspect ?? ((id) => `requests/${encodeURIComponent(id)}`), 'inspect'),
      usage: validateRoute(routes.usage ?? ((id) => `requests/${encodeURIComponent(id)}/usage`), 'usage'),
    };
  }

  async send({ executionId, attemptId, modelReference, payload, idempotencyKey = null }) {
    requireNonEmptyString(executionId, 'executionId');
    requireNonEmptyString(attemptId, 'attemptId');
    requireNonEmptyString(modelReference, 'modelReference');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw adapterError('INVALID_ADAPTER_INPUT', 'payload must be a JSON object');
    }
    if (idempotencyKey !== null) requireNonEmptyString(idempotencyKey, 'idempotencyKey');
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-newhumans-execution-id': executionId,
      'x-newhumans-attempt-id': attemptId,
    };
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    return this.#request('send', {
      method: 'POST',
      routeArgs: [executionId],
      headers,
      body: JSON.stringify({ model_reference: modelReference, payload }),
      requestedModelReference: modelReference,
    });
  }

  async cancel({ providerRequestId }) {
    requireNonEmptyString(providerRequestId, 'providerRequestId');
    return this.#request('cancel', {
      method: 'POST',
      routeArgs: [providerRequestId],
      headers: { accept: 'application/json' },
    });
  }

  async inspect({ providerRequestId }) {
    requireNonEmptyString(providerRequestId, 'providerRequestId');
    return this.#request('inspect', {
      method: 'GET',
      routeArgs: [providerRequestId],
      headers: { accept: 'application/json' },
    });
  }

  async usage({ providerRequestId }) {
    requireNonEmptyString(providerRequestId, 'providerRequestId');
    return this.#request('usage', {
      method: 'GET',
      routeArgs: [providerRequestId],
      headers: { accept: 'application/json' },
    });
  }

  async #request(operation, { method, routeArgs, headers, body = undefined, requestedModelReference = null }) {
    const routeValue = this.routes[operation](...routeArgs);
    const url = resolveRoute(this.baseUrl, routeValue, operation);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
      throw adapterError(timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_TRANSPORT_ERROR', timedOut
        ? 'provider request timed out with execution outcome unknown'
        : 'provider transport failed with execution outcome unknown', {
        operation,
        retryable: false,
        outcomeUnknown: true,
        cause,
      });
    }
    const payload = await readJsonResponse(response, operation);
    if (!response.ok) throw classifyHttpFailure(operation, response, payload);
    if (!payload) {
      throw adapterError('PROVIDER_MALFORMED_RESPONSE', 'provider success response must be a JSON object', {
        operation,
        httpStatus: response.status,
        outcomeUnknown: true,
      });
    }
    return responseEnvelope(operation, response, payload, { requestedModelReference });
  }
}

export function createJsonHttpCloudModelAdapter(options) {
  return assertCloudModelAdapter(new JsonHttpCloudModelAdapter(options));
}
