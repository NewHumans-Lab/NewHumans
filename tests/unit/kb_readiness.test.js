import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KB_CAPABILITIES,
  KB_READINESS,
  KbCapabilityWriteBlockedError,
  assertKbWriteReady,
  buildKbReadiness,
  evaluateKbCapabilityAccess,
} from '../../src/kb/readiness.js';

const binaryMatrix = [
  [false, false, false],
  [false, false, true],
  [false, true, false],
  [false, true, true],
  [true, false, false],
  [true, false, true],
  [true, true, false],
  [true, true, true],
];

for (const [economy, memory, knowledge] of binaryMatrix) {
  test(`partial failure matrix E${economy ? '✓' : '✗'} M${memory ? '✓' : '✗'} K${knowledge ? '✓' : '✗'}`, () => {
    const report = buildKbReadiness({ economy, memory, knowledge });
    const readyCount = [economy, memory, knowledge].filter(Boolean).length;
    const expected = readyCount === 3
      ? KB_READINESS.READY
      : readyCount === 0
        ? KB_READINESS.UNAVAILABLE
        : KB_READINESS.DEGRADED;
    assert.equal(report.overall, expected);
    assert.equal(report.capabilities.economy.write_ready, economy);
    assert.equal(report.capabilities.memory.write_ready, memory);
    assert.equal(report.capabilities.knowledge.write_ready, knowledge);
  });
}

test('E✓ M✗ K✓ is explicitly degraded and preserves healthy siblings', () => {
  const report = buildKbReadiness({ economy: true, memory: false, knowledge: true });
  assert.equal(report.overall, KB_READINESS.DEGRADED);
  assert.equal(evaluateKbCapabilityAccess(report, 'economy', 'read').allowed, true);
  assert.equal(evaluateKbCapabilityAccess(report, 'knowledge', 'write').allowed, true);
  assert.deepEqual(evaluateKbCapabilityAccess(report, 'memory', 'read').blocked_capabilities, ['memory']);
});

test('missing capability reports fail closed instead of making the KB look ready', () => {
  const report = buildKbReadiness({ economy: true, knowledge: true });
  assert.equal(report.overall, KB_READINESS.DEGRADED);
  assert.equal(report.capabilities.memory.reported, false);
  assert.equal(report.capabilities.memory.read_ready, false);
  assert.equal(report.capabilities.memory.write_ready, false);
  assert.equal(report.capabilities.memory.reason, 'NOT_REPORTED');
});

test('read-only capability remains readable but blocks writes', () => {
  const report = buildKbReadiness({
    economy: true,
    memory: { read_ready: true, write_ready: false, reason: 'UNAVAILABLE' },
    knowledge: true,
  });
  assert.equal(report.overall, KB_READINESS.DEGRADED);
  assert.equal(evaluateKbCapabilityAccess(report, 'memory', 'read').allowed, true);
  assert.equal(evaluateKbCapabilityAccess(report, 'memory', 'write').allowed, false);
  assert.throws(
    () => assertKbWriteReady(report, 'memory'),
    (error) => error instanceof KbCapabilityWriteBlockedError
      && error.blocked_capabilities.length === 1
      && error.blocked_capabilities[0] === 'memory',
  );
});

test('writes fail closed only on capabilities they actually require', () => {
  const report = buildKbReadiness({ economy: true, memory: false, knowledge: true });
  assert.equal(assertKbWriteReady(report, ['economy']).allowed, true);
  assert.equal(assertKbWriteReady(report, ['knowledge']).allowed, true);
  assert.throws(
    () => assertKbWriteReady(report, ['economy', 'memory']),
    (error) => error instanceof KbCapabilityWriteBlockedError
      && error.blocked_capabilities.includes('memory'),
  );
});

test('unknown capability names cannot bypass the guard', () => {
  const report = buildKbReadiness({ economy: true, memory: true, knowledge: true });
  assert.throws(() => assertKbWriteReady(report, 'billing'), RangeError);
  assert.deepEqual(KB_CAPABILITIES, ['economy', 'memory', 'knowledge']);
});
