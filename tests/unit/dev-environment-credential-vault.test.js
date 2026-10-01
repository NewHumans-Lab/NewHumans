import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialVaultPort } from '../../src/ports/credential_vault.js';
import { createDevEnvironmentCredentialVault } from '../../src/integrations/credential-vault/dev-environment-credential-vault.js';

test('dev env CredentialVault uses the shared port and exposes no secret material', async () => {
  const vault = createDevEnvironmentCredentialVault({
    env: { NODE_ENV: 'test', OPENAI_API_KEY: 'secret-value' },
  });

  assert.equal(vault instanceof CredentialVaultPort, true);
  const reference = await vault.get({ credentialRef: 'OPENAI_API_KEY', requesterId: 'm06' });
  assert.deepEqual(reference.toJSON(), { credentialRef: 'OPENAI_API_KEY', version: 1, state: 'ACTIVE' });
  assert.equal(JSON.stringify(reference).includes('secret-value'), false);
  assert.equal('secret' in reference, false);
});

test('dev env CredentialVault rejects an unconfigured credential', async () => {
  const vault = createDevEnvironmentCredentialVault({ env: { NODE_ENV: 'development' } });

  await assert.rejects(
    vault.get({ credentialRef: 'OPENAI_API_KEY', requesterId: 'm06' }),
    (error) => error.code === 'CREDENTIAL_MISSING' && error.status === 404,
  );
});

test('dev env CredentialVault rejects an empty credential', async () => {
  const vault = createDevEnvironmentCredentialVault({
    env: { NODE_ENV: 'development', OPENAI_API_KEY: '   ' },
  });

  await assert.rejects(
    vault.get({ credentialRef: 'OPENAI_API_KEY', requesterId: 'm06' }),
    (error) => error.code === 'INVALID_SECRET_MATERIAL',
  );
});

test('dev env CredentialVault refuses to start when its environment is production', () => {
  assert.throws(
    () => createDevEnvironmentCredentialVault({
      env: { NODE_ENV: 'production', OPENAI_API_KEY: 'must-not-load' },
    }),
    (error) => error.code === 'DEV_CREDENTIAL_VAULT_FORBIDDEN',
  );
});

test('explicit production nodeEnv cannot be bypassed by an injected development environment', () => {
  assert.throws(
    () => createDevEnvironmentCredentialVault({
      nodeEnv: 'production',
      env: { NODE_ENV: 'development', OPENAI_API_KEY: 'must-not-load' },
    }),
    (error) => error.code === 'DEV_CREDENTIAL_VAULT_FORBIDDEN',
  );
});

test('real production process environment cannot be bypassed by injected development settings', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(
      () => createDevEnvironmentCredentialVault({
        nodeEnv: 'development',
        env: { NODE_ENV: 'development', OPENAI_API_KEY: 'must-not-load' },
      }),
      (error) => error.code === 'DEV_CREDENTIAL_VAULT_FORBIDDEN',
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('dev env CredentialVault denies unapproved requesters', async () => {
  const vault = createDevEnvironmentCredentialVault({
    env: { NODE_ENV: 'development', OPENAI_API_KEY: 'secret-value' },
  });

  await assert.rejects(
    vault.get({ credentialRef: 'OPENAI_API_KEY', requesterId: 'business-code' }),
    (error) => error.code === 'CREDENTIAL_DENIED' && error.status === 403,
  );
});

test('dev env CredentialVault fails closed for rotate and revoke', async () => {
  const vault = createDevEnvironmentCredentialVault({
    env: { NODE_ENV: 'development', OPENAI_API_KEY: 'secret-value' },
  });

  await assert.rejects(
    vault.rotate({ credentialRef: 'OPENAI_API_KEY', requesterId: 'm06', secret: 'replacement' }),
    (error) => error.code === 'CREDENTIAL_ROTATION_UNSUPPORTED' && error.status === 405,
  );
  await assert.rejects(
    vault.revoke({ credentialRef: 'OPENAI_API_KEY', requesterId: 'm06' }),
    (error) => error.code === 'CREDENTIAL_REVOCATION_UNSUPPORTED' && error.status === 405,
  );
});
