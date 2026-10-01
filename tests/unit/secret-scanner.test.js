import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatFinding, scanPaths, scanText } from '../../scripts/secret-scanner.js';

function fakeSecret() {
  return ['nh', 'fake', 'secret', '0123456789ABCDEFGHIJKLMNOP'].join('_');
}

test('detects an embedded fake secret assignment without returning the secret', () => {
  const secret = fakeSecret();
  const findings = scanText(`api_token = "${secret}"\n`, 'fixture.log');

  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'GENERIC_API_TOKEN');
  assert.equal(findings[0].file, 'fixture.log');
  assert.equal(findings[0].line, 1);
  assert.equal(Object.values(findings[0]).includes(secret), false);
  assert.equal(formatFinding(findings[0]).includes(secret), false);
});

test('does not report a normal UUID', () => {
  const uuid = '123e4567-e89b-42d3-a456-426614174000';
  assert.deepEqual(scanText(`request_id=${uuid}\ntoken=${uuid}\n`, 'sample.log'), []);
});

test('detects private key headers', () => {
  const header = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const findings = scanText(`${header}\nredacted\n`, 'fixtures/key.pem');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'PRIVATE_KEY');
});

test('scans fixture and log-sample directories recursively', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-secret-scan-'));
  try {
    fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'fixtures', 'clean.json'), '{"id":"123e4567-e89b-42d3-a456-426614174000"}\n');
    fs.writeFileSync(path.join(root, 'logs', 'sample.log'), `auth_token=${fakeSecret()}\n`);

    const { findings, filesScanned } = scanPaths([root]);
    assert.equal(filesScanned, 2);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, 'GENERIC_AUTH_TOKEN');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detects provider-prefixed environment variable names', () => {
  const secret = fakeSecret();
  const findings = scanText(`OPENAI_API_KEY=${secret}\n`, '.env.local');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'GENERIC_OPENAI_API_KEY');
});

test('ignores code references and explicit test placeholder values', () => {
  assert.deepEqual(scanText('const secret = prepared.plan.credential_env_key;\n', 'gateway.js'), []);
  assert.deepEqual(scanText('OPENAI_API_KEY=replace-with-a-real-secret-outside-version-control\n', '.env.example'), []);
  assert.deepEqual(scanText("apiKey: 'must-not-persist'\n", 'test.js'), []);
  assert.deepEqual(scanText("credential_secret: 'raw-credential-secret'\n", 'logger.test.js'), []);
  assert.deepEqual(scanText("accessToken: 'nested-token'\n", 'logger.test.js'), []);
});

test('repository scan has no obvious secrets', () => {
  const { findings } = scanPaths(['.']);
  assert.deepEqual(findings, []);
});
