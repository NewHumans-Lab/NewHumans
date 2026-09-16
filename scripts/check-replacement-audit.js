import fs from 'node:fs';

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath || !fs.existsSync(eventPath)) {
  console.log('replacement audit check skipped: no GitHub event payload');
  process.exit(0);
}

const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
if (!event.pull_request) {
  console.log('replacement audit check skipped: not a pull request event');
  process.exit(0);
}

const body = event.pull_request.body || '';
const matches = [...body.matchAll(/^Replacement-Audit:\s*(APPLICABLE|NOT_APPLICABLE)\s*$/gmi)];
if (matches.length !== 1) {
  console.error('PR must contain exactly one `Replacement-Audit: APPLICABLE` or `Replacement-Audit: NOT_APPLICABLE` declaration.');
  process.exit(1);
}

const mode = matches[0][1].toUpperCase();
if (mode === 'APPLICABLE') {
  for (const field of ['Superseded-Paths', 'Cleanup-Evidence', 'Regression-Evidence']) {
    const match = body.match(new RegExp(`^${field}:\\s*(.+)$`, 'mi'));
    const value = match?.[1]?.trim();
    if (!value || /^N\/?A$/i.test(value) || /describe .* here/i.test(value)) {
      console.error(`Replacement-Audit is APPLICABLE, so ${field} must contain concrete evidence.`);
      process.exit(1);
    }
  }
}

console.log(`replacement audit declaration accepted: ${mode}`);
