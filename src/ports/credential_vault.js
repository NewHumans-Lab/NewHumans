const VALID_STATES = new Set(['ACTIVE', 'REVOKED']);

function assertCredentialRef(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CredentialVaultError('INVALID_CREDENTIAL_REF', 'credentialRef must be a non-empty opaque reference');
  }
  return value;
}

function assertVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CredentialVaultError('CREDENTIAL_VAULT_INVALID_RESPONSE', 'credential vault returned an invalid version', { status: 502 });
  }
  return value;
}

function assertState(value) {
  if (!VALID_STATES.has(value)) {
    throw new CredentialVaultError('CREDENTIAL_VAULT_INVALID_RESPONSE', 'credential vault returned an invalid state', { status: 502 });
  }
  return value;
}

class CredentialReference {
  #credentialRef;
  #version;
  #state;

  constructor({ credentialRef, version, state }) {
    this.#credentialRef = assertCredentialRef(credentialRef);
    this.#version = assertVersion(version);
    this.#state = assertState(state);
    Object.freeze(this);
  }

  get credentialRef() { return this.#credentialRef; }
  get version() { return this.#version; }
  get state() { return this.#state; }

  toJSON() {
    return { credentialRef: this.#credentialRef, version: this.#version, state: this.#state };
  }

  toString() {
    return `[CredentialReference ${this.#credentialRef} v${this.#version} ${this.#state}]`;
  }
}

function referenceFromResult(credentialRef, result, expectedState = null) {
  if (!result || typeof result !== 'object') {
    throw new CredentialVaultError('CREDENTIAL_VAULT_INVALID_RESPONSE', 'credential vault returned invalid metadata', { status: 502, credentialRef });
  }
  const state = assertState(result.state ?? 'ACTIVE');
  if (expectedState && state !== expectedState) {
    throw new CredentialVaultError('CREDENTIAL_VAULT_INVALID_RESPONSE', `credential vault must return state ${expectedState}`, { status: 502, credentialRef });
  }
  return new CredentialReference({ credentialRef, version: assertVersion(result.version), state });
}

export class CredentialVaultError extends Error {
  constructor(code, message, { status = 500, credentialRef = null } = {}) {
    super(message);
    this.name = 'CredentialVaultError';
    this.code = code;
    this.status = status;
    this.credentialRef = credentialRef;
  }
}

export class CredentialVaultPort {
  #adapter;

  constructor(adapter) {
    if (!adapter || typeof adapter !== 'object') throw new TypeError('CredentialVaultPort requires an adapter');
    for (const method of ['get', 'rotate', 'revoke']) {
      if (typeof adapter[method] !== 'function') throw new TypeError(`CredentialVaultPort adapter.${method} must be a function`);
    }
    this.#adapter = adapter;
  }

  async get({ credentialRef, requesterId }) {
    const ref = assertCredentialRef(credentialRef);
    const result = await this.#adapter.get({ credentialRef: ref, requesterId });
    return referenceFromResult(ref, result, 'ACTIVE');
  }

  async rotate({ credentialRef, requesterId, secret }) {
    const ref = assertCredentialRef(credentialRef);
    const result = await this.#adapter.rotate({ credentialRef: ref, requesterId, secret });
    return referenceFromResult(ref, result, 'ACTIVE');
  }

  async revoke({ credentialRef, requesterId }) {
    const ref = assertCredentialRef(credentialRef);
    const result = await this.#adapter.revoke({ credentialRef: ref, requesterId });
    return referenceFromResult(ref, result, 'REVOKED');
  }
}
