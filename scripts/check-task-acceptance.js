import fs from 'node:fs';
import { validateTaskAcceptance } from './task-acceptance.js';

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath || !fs.existsSync(eventPath)) {
  console.log('task acceptance check skipped: no GitHub event payload');
  process.exit(0);
}

let event;
try {
  event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
} catch (error) {
  console.error(`task acceptance check failed: invalid GitHub event payload: ${error.message}`);
  process.exit(1);
}

if (!event.pull_request) {
  console.log('task acceptance check skipped: not a pull request event');
  process.exit(0);
}

const pr = event.pull_request;
const phase = pr.merged === true ? 'final' : 'premerge';
const result = validateTaskAcceptance(pr.body || '', {
  phase,
  expectedMergeSha: phase === 'final' ? pr.merge_commit_sha : null,
});

if (!result.ok) {
  console.error(`task acceptance rejected (${phase}):`);
  for (const error of result.errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`task acceptance accepted (${phase}): ${result.values['Task-ID']}`);
