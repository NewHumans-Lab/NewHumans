import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialVaultError, CredentialVaultPort } from '../../src/ports/credential_vault.js';

class MockCredentialVaultAdapter {
  #records = new Map();
  #allowedRequesterIds;

  constructor({ allowedRequesterIds = [] } = {}) {
    this.#allowedRequesterIds = new Set(allowedRequesterIds);
  }

  seed(credentialRef, secret, version = 1) {
    this.#records.set(credentialRef, { secret, version, revoked: false });
  }

  #authorize(requesterId, credentialRef) {
    if (!this.#allowedRequesterIds.has(requesterId)) {
      throw new CredentialVaultError('CREDENTIAL_DENIED', 'credential access denied', { status: 403, credentialRef });
    }
  }

  #load(credentialRef) {
    const record = this.#records.get(credentialRef);
    if (!record) throw new CredentialVaultError('CREDENTIAL_MISSING', 'credential reference does not exist', { status: 404, credentialRef });
    return record;
  }

  async get({ credentialRef, requesterId }) {
    this.#authorize(requesterId, credentialRef);
    const record = this.#load(credentialRef);
    if (record.revoked) throw new CredentialVaultError('CREDENTIAL_REVOKED', 'credential reference is revoked', { status: 410, credentialRef });
    return { version: record.version, state: 'ACTIVE', secret: record.secret };
  }

  async rotate({ credentialRef, requesterId, secret }) {
    this.#authorize(requesterId, credentialRef);
    if (typeof secret !== 'string' || secret.length === 0) throw new CredentialVaultError('INVALID_SECRET_MATERIAL', 'rotation requires non-empty secret material');
    const current = this.#records.get(credentialRef);
    const next = { secret, version: (current?.version ?? 0) + 1, revoked: false };
    this.#records.set(credentialRef, next);
    return { version: next.version, state: 'ACTIVE', secret: next.secret };
  }

  async revoke({ credentialRef, requesterId }) {
    this.#authorize(requesterId, credentialRef);
    const current = this.#load(credentialRef);
    current.revoked = true;
    return { version: current.version, state: 'REVOKED', secret: current.secret };
  }

  secretMatchesForTest(credentialRef, candidate) {
    return this.#records.get(credentialRef)?.secret === candidate;
  }
}

function createFixture() {
  const adapter = new MockCredentialVaultAdapter({ allowedRequesterIds: ['m06'] });
  return { adapter, vault: new CredentialVaultPort(adapter) };
}

test('get exposes only non-secret credential reference metadata', async () => {
  const { adapter, vault } = createFixture();
  adapter.seed('cred-openai-primary', 'sk-super-secret');

  const reference = await vault.get({ credentialRef: 'cred-openai-primary', requesterId: 'm06' });

  assert.equal(reference.credentialRef, 'cred-openai-primary');
  assert.equal(reference.version, 1);
  assert.equal(reference.state, 'ACTIVE');
  assert.equal('secret' in reference, false);
  assert.equal('value' in reference, false);
  assert.equal(JSON.stringify(reference), '{"credentialRef":"cred-openai-primary","version":1,"state":"ACTIVE"}');
  assert.equal(JSON.stringify(reference).includes('sk-super-secret'), false);
});

test('rotate replaces hidden secret material and returns only a new reference version', async () => {
  const { adapter, vault } = createFixture();
  adapter.seed('cred-openai-primary', 'old-secret', 3);

  const reference = await vault.rotate({ credentialRef: 'cred-openai-primary', requesterId: 'm06', secret: 'new-secret' });

  assert.equal(reference.version, 4);
  assert.equal(reference.state, 'ACTIVE');
  assert.equal(adapter.secretMatchesForTest('cred-openai-primary', 'new-secret'), true);
  assert.equal(JSON.stringify(reference).includes('new-secret'), false);
  assert.equal(JSON.stringify(reference).includes('old-secret'), false);
});

test('revoke returns non-secret evidence, blocks future get, and leaves prior references non-capabilities', async () => {
  const { adapter, vault } = createFixture();
  adapter.seed('cred-openai-primary', 'secret');
  const prior = await vault.get({ credentialRef: 'cred-openai-primary', requesterId: 'm06' });

  const revoked = await vault.revoke({ credentialRef: 'cred-openai-primary', requesterId: 'm06' });

  assert.deepEqual(revoked.toJSON(), { credentialRef: 'cred-openai-primary', version: 1, state: 'REVOKED' });
  assert.deepEqual(prior.toJSON(), { credentialRef: 'cred-openai-primary', version: 1, state: 'ACTIVE' });
  assert.equal('secret' in prior, false);
  assert.equal(JSON.stringify(prior).includes('secret'), false);
  await assert.rejects(
    vault.get({ credentialRef: 'cred-openai-primary', requesterId: 'm06' }),
    (error) => error.code === 'CREDENTIAL_REVOKED' && error.status === 410,
  );
});

test('missing credential refs fail closed without manufacturing a value', async () => {
  const { vault } = createFixture();

  await assert.rejects(
    vault.get({ credentialRef: 'cred-missing', requesterId: 'm06' }),
    (error) => error.code === 'CREDENTIAL_MISSING' && error.status === 404 && error.credentialRef === 'cred-missing',
  );
});

test('denied callers cannot get, rotate or revoke credentials', async () => {
  const { adapter, vault } = createFixture();
  adapter.seed('cred-openai-primary', 'secret');

  for (const operation of [
    () => vault.get({ credentialRef: 'cred-openai-primary', requesterId: 'business-code' }),
    () => vault.rotate({ credentialRef: 'cred-openai-primary', requesterId: 'business-code', secret: 'replacement' }),
    () => vault.revoke({ credentialRef: 'cred-openai-primary', requesterId: 'business-code' }),
  ]) {
    await assert.rejects(operation(), (error) => error.code === 'CREDENTIAL_DENIED' && error.status === 403);
  }
});
