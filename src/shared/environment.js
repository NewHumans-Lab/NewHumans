const NODE_ENVIRONMENTS = new Set(['development', 'test', 'production']);
const KB_PROVIDERS = new Set(['knowledge-ball', 'mock', 'local-economy']);
const PRODUCTION_KB_PROVIDERS = new Set(['knowledge-ball']);

export class EnvironmentValidationError extends Error {
  constructor(issues) {
    super(`Invalid environment configuration: ${issues.join('; ')}`);
    this.name = 'EnvironmentValidationError';
    this.code = 'INVALID_ENVIRONMENT';
    this.issues = issues;
  }
}

function requiredString(env, key, issues) {
  const value = env[key];
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(`${key} is required`);
    return null;
  }
  return value.trim();
}

function validateDatabaseUrl(value, issues) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
      issues.push('DATABASE_URL must use postgres:// or postgresql://');
    }
  } catch {
    issues.push('DATABASE_URL must be a valid PostgreSQL URL');
  }
}

function validateHttpUrl(value, key, issues) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      issues.push(`${key} must use http:// or https://`);
      return null;
    }
    return url.toString();
  } catch {
    issues.push(`${key} must be a valid HTTP(S) URL`);
    return null;
  }
}

export function validateEnvironment(env = process.env) {
  const issues = [];
  const databaseUrl = requiredString(env, 'DATABASE_URL', issues);
  const nodeEnv = requiredString(env, 'NODE_ENV', issues);
  const kbProvider = requiredString(env, 'KB_PROVIDER', issues);

  validateDatabaseUrl(databaseUrl, issues);

  if (nodeEnv && !NODE_ENVIRONMENTS.has(nodeEnv)) {
    issues.push(`NODE_ENV must be one of: ${[...NODE_ENVIRONMENTS].join(', ')}`);
  }

  if (kbProvider && !KB_PROVIDERS.has(kbProvider)) {
    issues.push(`KB_PROVIDER must be one of: ${[...KB_PROVIDERS].join(', ')}`);
  }

  let kbEndpoint = null;
  if (kbProvider === 'knowledge-ball') {
    const endpoint = requiredString(env, 'KB_ENDPOINT', issues);
    kbEndpoint = validateHttpUrl(endpoint, 'KB_ENDPOINT', issues);
  } else if (typeof env.KB_ENDPOINT === 'string' && env.KB_ENDPOINT.trim() !== '') {
    kbEndpoint = validateHttpUrl(env.KB_ENDPOINT.trim(), 'KB_ENDPOINT', issues);
  }

  if (nodeEnv === 'production' && kbProvider && !PRODUCTION_KB_PROVIDERS.has(kbProvider)) {
    issues.push('production requires KB_PROVIDER=knowledge-ball; mock/local-economy are forbidden');
  }

  if (issues.length) throw new EnvironmentValidationError(issues);

  return Object.freeze({
    databaseUrl,
    nodeEnv,
    kbProvider,
    kbEndpoint,
  });
}
