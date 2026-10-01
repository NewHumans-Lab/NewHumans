import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const correlationContextStorage = new AsyncLocalStorage();
const CONTEXT_KEYS = ['requestId', 'actionId', 'correlationId'];

function isPresent(value) {
  return value !== undefined;
}

function validateId(name, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function resolveId(name, overrides, parent) {
  if (isPresent(overrides[name])) return validateId(name, overrides[name]);
  if (parent) return parent[name];
  return randomUUID();
}

export function createCorrelationContext(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('correlation context overrides must be an object');
  }

  const parent = correlationContextStorage.getStore() ?? null;
  const context = {};
  for (const key of CONTEXT_KEYS) context[key] = resolveId(key, overrides, parent);
  return Object.freeze(context);
}

export function runWithCorrelationContext(overrides, callback) {
  if (typeof callback !== 'function') throw new TypeError('correlation context callback must be a function');
  const context = createCorrelationContext(overrides);
  return correlationContextStorage.run(context, callback, context);
}

export function getCorrelationContext() {
  return correlationContextStorage.getStore() ?? null;
}

export function requireCorrelationContext() {
  const context = getCorrelationContext();
  if (!context) {
    throw Object.assign(new Error('correlation context is required'), { code: 'CORRELATION_CONTEXT_REQUIRED' });
  }
  return context;
}
