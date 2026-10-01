import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanArchitecture } from '../../scripts/check-architecture-regressions.js';

const scanner = path.resolve('scripts/check-architecture-regressions.js');

function withFixture(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-architecture-regression-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, content);
    }
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runFixture(files) {
  return withFixture(files, (root) => spawnSync(process.execPath, [scanner, root], { encoding: 'utf8' }));
}

test('current repository satisfies architecture boundary scan', () => {
  assert.deepEqual(scanArchitecture(process.cwd()), []);
});

test('rejects a new Memory/Knowledge/Wallet authority table', () => {
  const out = runFixture({
    'migrations/999_bad.sql': 'CREATE TABLE runtime.memories (memory_id uuid primary key);',
  });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /AUTHORITY_TABLE/);
});

test('rejects a new direct import of the legacy Economy service', () => {
  const out = runFixture({
    'src/services/economy.js': 'export const getWallet = () => null;',
    'src/services/new-feature.ts': "import { getWallet } from './economy';\nexport { getWallet };",
  });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /ILLEGAL_ECONOMY_IMPORT/);
});

test('rejects a Mock Provider in production source', () => {
  const out = runFixture({
    'src/providers/openai-provider.ts': 'export class MockOpenAIProvider { async infer() { return {}; } }',
  });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /PRODUCTION_MOCK_PROVIDER/);
});

test('test-only mocks do not count as production providers', () => {
  const out = runFixture({
    'tests/fixtures/mock-provider.ts': 'export class MockOpenAIProvider {}',
  });
  assert.equal(out.status, 0, out.stderr);
});
