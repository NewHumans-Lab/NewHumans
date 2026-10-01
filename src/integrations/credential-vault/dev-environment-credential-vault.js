import { CredentialVaultError, CredentialVaultPort } from '../../ports/credential_vault.js';

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;

function assertEnvCredentialRef(credentialRef) {
  if (typeof credentialRef !== 'string' || !ENV_KEY_PATTERN.test(credentialRef)) {
    throw new CredentialVaultError(
      'INVALID_CREDENTIAL_REF',
      'development environment credentialRef must be an environment variable name',
      { status: 400, credentialRef: typeof credentialRef === 'string' ? credentialRef : null },
    );
  }
  return credentialRef;
}

class DevEnvironmentCredentialVaultAdapter {
  #env;
  #allowedRequesterIds;

  constructor({ env = process.env, nodeEnv, allowedRequesterIds = ['m06'] } = {}) {
    const injectedNodeEnv = env && typeof env === 'object' ? env.NODE_ENV : undefined;
    if (process.env.NODE_ENV === 'production' || nodeEnv === 'production' || injectedNodeEnv === 'production') {
      throw new CredentialVaultError(
        'DEV_CREDENTIAL_VAULT_FORBIDDEN',
        'development environment CredentialVault cannot be used when NODE_ENV=production',
      );
    }
    if (!env || typeof env !== 'object') {
      throw new CredentialVaultError('INVALID_CREDENTIAL_ENV', 'development CredentialVault requires an environment object');
    }
    this.#env = env;
    this.#allowedRequesterIds = new Set(allowedRequesterIds);
  }

  #authorize(requesterId, credentialRef) {
    if (!this.#allowedRequesterIds.has(requesterId)) {
      throw new CredentialVaultError('CREDENTIAL_DENIED', 'credential access denied', {
        status: 403,
        credentialRef,
      });
    }
  }

  #loadSecret(credentialRef) {
    if (!Object.hasOwn(this.#env, credentialRef) || this.#env[credentialRef] === undefined) {
      throw new CredentialVaultError('CREDENTIAL_MISSING', 'credential reference is not configured', {
        status: 404,
        credentialRef,
      });
    }
    const secret = this.#env[credentialRef];
    if (typeof secret !== 'string' || secret.trim().length === 0) {
      throw new CredentialVaultError('INVALID_SECRET_MATERIAL', 'configured development credential is empty', {
        credentialRef,
      });
    }
    return secret;
  }

  async get({ credentialRef, requesterId } = {}) {
    const ref = assertEnvCredentialRef(credentialRef);
    this.#authorize(requesterId, ref);
    const secret = this.#loadSecret(ref);
    return { version: 1, state: 'ACTIVE', secret };
  }

  async rotate({ credentialRef, requesterId } = {}) {
    const ref = assertEnvCredentialRef(credentialRef);
    this.#authorize(requesterId, ref);
    throw new CredentialVaultError(
      'CREDENTIAL_ROTATION_UNSUPPORTED',
      'development environment CredentialVault cannot rotate environment variables',
      { status: 405, credentialRef: ref },
    );
  }

  async revoke({ credentialRef, requesterId } = {}) {
    const ref = assertEnvCredentialRef(credentialRef);
    this.#authorize(requesterId, ref);
    throw new CredentialVaultError(
      'CREDENTIAL_REVOCATION_UNSUPPORTED',
      'development environment CredentialVault cannot revoke environment variables',
      { status: 405, credentialRef: ref },
    );
  }
}

export function createDevEnvironmentCredentialVault(options) {
  return new CredentialVaultPort(new DevEnvironmentCredentialVaultAdapter(options));
}
