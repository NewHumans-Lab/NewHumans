import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const v3 = readFileSync(new URL('../../docs/NewHumans_System_Spec_V3.md', import.meta.url), 'utf8');
const delta = readFileSync(new URL('../../docs/NewHumans_Design_Spec_Delta_V3_Ownership.md', import.meta.url), 'utf8');

const V3_RESPONSIBILITIES = Object.freeze({
  'M03 Knowledge Ball': {
    sourceList: '公共知识节点、证据、个人状态层、记忆引用、挑战及展示组件',
    items: ['公共知识节点', '证据', '个人状态层', '记忆引用', '挑战', '展示组件'],
  },
  'M05 Economy': {
    sourceList: '官方货币 Energy、日活动费、报价、资金预留、托管、结算与财政',
    items: ['官方货币 Energy', '日活动费', '报价', '资金预留', '托管', '结算', '财政'],
  },
});

const EXPECTED_DELTA = new Map([
  ['V3-M03-01', ['M03 Knowledge Ball', '公共知识节点', 'Knowledge Ball / Knowledge']],
  ['V3-M03-02', ['M03 Knowledge Ball', '证据', 'Knowledge Ball / Knowledge']],
  ['V3-M03-03', ['M03 Knowledge Ball', '个人状态层', 'Knowledge Ball / Memory + Knowledge']],
  ['V3-M03-04', ['M03 Knowledge Ball', '记忆引用', 'Knowledge Ball / Memory']],
  ['V3-M03-05', ['M03 Knowledge Ball', '挑战', 'Knowledge Ball / Knowledge']],
  ['V3-M03-06', ['M03 Knowledge Ball', '展示组件', 'Knowledge Ball + NewHumans M07 (presentation composition only)']],
  ['V3-M05-01', ['M05 Economy', '官方货币 Energy', 'Knowledge Ball / Economy']],
  ['V3-M05-02', ['M05 Economy', '日活动费', 'Knowledge Ball / Economy']],
  ['V3-M05-03', ['M05 Economy', '报价', 'Knowledge Ball / Economy']],
  ['V3-M05-04', ['M05 Economy', '资金预留', 'Knowledge Ball / Economy']],
  ['V3-M05-05', ['M05 Economy', '托管', 'Knowledge Ball / Economy']],
  ['V3-M05-06', ['M05 Economy', '结算', 'Knowledge Ball / Economy']],
  ['V3-M05-07', ['M05 Economy', '财政', 'Knowledge Ball / Economy']],
]);

function parseAuditRows(markdown) {
  const rows = new Map();
  for (const line of markdown.split('\n')) {
    if (!/^\| V3-M0[35]-\d{2} \|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    assert.equal(cells.length, 5, `audit row must have five cells: ${line}`);
    const [id, owner, responsibility, authority] = cells;
    assert.equal(rows.has(id), false, `duplicate audit id: ${id}`);
    rows.set(id, [owner, responsibility, authority]);
  }
  return rows;
}

test('V3 baseline M03 and M05 responsibility lists remain exact and traceable', () => {
  for (const [owner, { sourceList }] of Object.entries(V3_RESPONSIBILITIES)) {
    assert.equal(
      v3.includes(`| ${owner} | ${sourceList} |`),
      true,
      `V3 baseline row changed or disappeared for ${owner}`,
    );
  }
});

test('every V3 M03/M05 responsibility has exactly one explicit current owner', () => {
  const rows = parseAuditRows(delta);
  assert.equal(rows.size, EXPECTED_DELTA.size, 'delta must contain exactly the audited M03/M05 responsibility rows');

  for (const [id, expected] of EXPECTED_DELTA) {
    assert.deepEqual(rows.get(id), expected, `ownership delta mismatch for ${id}`);
  }

  const expectedResponsibilities = Object.values(V3_RESPONSIBILITIES).flatMap(({ items }) => items).sort();
  const actualResponsibilities = [...rows.values()].map(([, responsibility]) => responsibility).sort();
  assert.deepEqual(actualResponsibilities, expectedResponsibilities, 'old responsibilities must be neither omitted nor duplicated');
});

test('delta preserves precedence, dependency, single-writer and fail-closed rules', () => {
  assert.match(delta, /只覆盖 V3/);
  assert.match(delta, /历史设计基线/);
  assert.match(delta, /同一状态只能有一个 `AUTHORITATIVE_WRITER`/);
  assert.match(delta, /Knowledge Ball 是以下三类状态的唯一可写权威/);
  assert.match(delta, /must not fall back to the legacy local ledger/);
  assert.match(delta, /OUTCOME_UNKNOWN/);
  assert.match(delta, /do not assume cross-database ACID/);
  assert.match(delta, /显式绑定/);

  for (let task = 2; task <= 12; task += 1) {
    assert.match(delta, new RegExp(`NH-${String(task).padStart(3, '0')}`), `missing prerequisite NH-${task}`);
  }
});
