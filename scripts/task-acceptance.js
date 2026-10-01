export const REQUIRED_TASK_ACCEPTANCE_FIELDS = Object.freeze([
  'Task-ID',
  'Scope',
  'Tests',
  'Self-Review',
  'Known-Limitations',
  'Merge-SHA',
]);

const PLACEHOLDER_RE = /^(?:TODO|TBD|PENDING|N\/?A|NONE PROVIDED|DESCRIBE\b|REPLACE\b|FILL\b|<.*>|\[.*\])$/i;
const SHA40_RE = /^[0-9a-f]{40}$/i;

function collectFieldValues(body, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}:\\s*(.*)$`, 'gmi');
  return [...String(body ?? '').matchAll(re)].map((match) => match[1].trim());
}

function isConcrete(value) {
  if (!value) return false;
  return !PLACEHOLDER_RE.test(value.trim());
}

export function parseTaskAcceptance(body) {
  const values = {};
  const errors = [];

  for (const field of REQUIRED_TASK_ACCEPTANCE_FIELDS) {
    const matches = collectFieldValues(body, field);
    if (matches.length !== 1) {
      errors.push(`${field} must appear exactly once; found ${matches.length}.`);
      continue;
    }
    values[field] = matches[0];
  }

  return { values, errors };
}

export function validateTaskAcceptance(body, options = {}) {
  const phase = options.phase ?? 'premerge';
  if (!['premerge', 'final'].includes(phase)) {
    throw new Error(`unsupported task acceptance phase: ${phase}`);
  }

  const expectedMergeSha = options.expectedMergeSha?.trim().toLowerCase() || null;
  const { values, errors } = parseTaskAcceptance(body);

  for (const field of ['Task-ID', 'Scope', 'Tests']) {
    if (field in values && !isConcrete(values[field])) {
      errors.push(`${field} must contain concrete evidence, not a placeholder.`);
    }
  }

  if ('Self-Review' in values && values['Self-Review'].toUpperCase() !== 'APPROVED') {
    errors.push('Self-Review must be APPROVED.');
  }

  if ('Known-Limitations' in values) {
    const limitations = values['Known-Limitations'];
    if (!limitations || /^(?:TODO|TBD|PENDING|N\/?A)$/i.test(limitations)) {
      errors.push('Known-Limitations must be NONE or a concrete limitation statement.');
    }
  }

  if ('Merge-SHA' in values) {
    const mergeSha = values['Merge-SHA'];
    if (phase === 'premerge') {
      if (mergeSha.toUpperCase() !== 'PENDING') {
        errors.push('Merge-SHA must be PENDING before merge.');
      }
    } else {
      if (!SHA40_RE.test(mergeSha)) {
        errors.push('Merge-SHA must be the 40-character merge commit SHA after merge.');
      } else if (expectedMergeSha && mergeSha.toLowerCase() !== expectedMergeSha) {
        errors.push(`Merge-SHA does not match GitHub merge_commit_sha ${expectedMergeSha}.`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    phase,
    values,
    errors,
  };
}
