import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EnvironmentValidationError, validateEnvironment } from '../../src/shared/environment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../fixtures/environment');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, `${name}.json`), 'utf8'));
}

test('development, test and production fixtures validate', () => {
  assert.equal(validateEnvironment(fixture('development')).nodeEnv, 'development');
  assert.equal(validateEnvironment(fixture('test')).kbProvider, 'mock');
  assert.equal(validateEnvironment(fixture('production')).kbProvider, 'knowledge-ball');
});

test('required variables and URL shapes fail closed', () => {
  assert.throws(
    () => validateEnvironment({ NODE_ENV: 'development', KB_PROVIDER: 'knowledge-ball' }),
    (error) => error instanceof EnvironmentValidationError
      && error.code === 'INVALID_ENVIRONMENT'
      && error.issues.includes('DATABASE_URL is required')
      && error.issues.includes('KB_ENDPOINT is required'),
  );
  assert.throws(
    () => validateEnvironment({ ...fixture('development'), DATABASE_URL: 'https://db.example.test', KB_ENDPOINT: 'file:///tmp/kb' }),
    (error) => error.issues.includes('DATABASE_URL must use postgres:// or postgresql://')
      && error.issues.includes('KB_ENDPOINT must use http:// or https://'),
  );
});

test('production forbids mock and local-economy providers', () => {
  const production = fixture('production');
  for (const kbProvider of ['mock', 'local-economy']) {
    assert.throws(
      () => validateEnvironment({ ...production, KB_PROVIDER: kbProvider }),
      (error) => error instanceof EnvironmentValidationError
        && error.issues.includes('production requires KB_PROVIDER=knowledge-ball; mock/local-economy are forbidden'),
    );
  }
});

test('startup exits before server import when production KB provider is unsafe', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/start.js')], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, ...fixture('production'), KB_PROVIDER: 'mock' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /production requires KB_PROVIDER=knowledge-ball/);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
});
