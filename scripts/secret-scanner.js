import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_IGNORED_DIRS = new Set(['.git', 'node_modules', 'coverage']);
const BINARY_EXTENSIONS = new Set([
  '.7z', '.avi', '.bin', '.bmp', '.class', '.dll', '.doc', '.docx', '.exe', '.gif', '.gz',
  '.ico', '.jar', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.o', '.pdf', '.png', '.so', '.tar',
  '.tgz', '.webp', '.woff', '.woff2', '.xls', '.xlsx', '.zip'
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLACEHOLDER_RE = /^(?:(?:example|sample|placeholder|changeme|replace|your|dummy|test|raw|nested)(?:[-_].*)?|<.*>|\$\{.*\})$/i;

const HIGH_CONFIDENCE_PATTERNS = [
  { type: 'PRIVATE_KEY', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { type: 'AWS_ACCESS_KEY_ID', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { type: 'GITHUB_TOKEN', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: 'GITHUB_FINE_GRAINED_TOKEN', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { type: 'SLACK_TOKEN', regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { type: 'STRIPE_SECRET_KEY', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { type: 'SK_TOKEN', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'GOOGLE_API_KEY', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'GITLAB_TOKEN', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g }
];

const SENSITIVE_ASSIGNMENT_RE = /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|api[_-]?token|access[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|token|client[_-]?secret|secret|password))\b\s*[:=]\s*["'`]?([A-Za-z0-9_./+=:-]{16,})/gi;

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

function looksLikePlaceholder(value) {
  return UUID_RE.test(value) || PLACEHOLDER_RE.test(value);
}

function looksLikeCodeReference(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(value);
}

function looksSecretLike(value) {
  if (looksLikePlaceholder(value) || looksLikeCodeReference(value)) return false;
  const categories = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[_./+=:-]/.test(value)].filter(Boolean).length;
  if (categories >= 3) return true;
  return value.length >= 20 && categories >= 2 && new Set(value).size >= 10;
}

function addFinding(findings, seen, { file, text, index, type, value }) {
  const key = `${file}:${index}:${type}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push({
    file,
    line: lineNumberAt(text, index),
    type,
    fingerprint: fingerprint(value)
  });
}

export function scanText(text, file = '<memory>') {
  const findings = [];
  const seen = new Set();

  for (const { type, regex } of HIGH_CONFIDENCE_PATTERNS) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      addFinding(findings, seen, {
        file,
        text,
        index: match.index,
        type,
        value: match[0]
      });
    }
  }

  SENSITIVE_ASSIGNMENT_RE.lastIndex = 0;
  for (const match of text.matchAll(SENSITIVE_ASSIGNMENT_RE)) {
    const value = match[2];
    if (!looksSecretLike(value)) continue;
    addFinding(findings, seen, {
      file,
      text,
      index: match.index,
      type: `GENERIC_${match[1].toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
      value
    });
  }

  return findings;
}

function isLikelyBinary(buffer, file) {
  if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) return true;
  const sampleLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < sampleLength; i += 1) if (buffer[i] === 0) return true;
  return false;
}

function collectFiles(target, files) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    if (DEFAULT_IGNORED_DIRS.has(path.basename(target))) return;
    for (const entry of fs.readdirSync(target)) collectFiles(path.join(target, entry), files);
    return;
  }
  if (stat.isFile()) files.push(target);
}

export function scanPaths(targets = ['.']) {
  const files = [];
  for (const target of targets) collectFiles(path.resolve(target), files);

  const findings = [];
  let filesScanned = 0;
  for (const file of files) {
    const buffer = fs.readFileSync(file);
    if (isLikelyBinary(buffer, file)) continue;
    const text = buffer.toString('utf8');
    filesScanned += 1;
    findings.push(...scanText(text, path.relative(process.cwd(), file) || path.basename(file)));
  }

  return { findings, filesScanned };
}

export function formatFinding(finding) {
  return `[secret-scan] ${finding.type} ${finding.file}:${finding.line} ${finding.fingerprint}`;
}

export function runCli(args = process.argv.slice(2)) {
  const targets = args.length ? args : ['.'];
  const { findings, filesScanned } = scanPaths(targets);
  if (findings.length) {
    for (const finding of findings) console.error(formatFinding(finding));
    console.error(`[secret-scan] failed: ${findings.length} finding(s) across ${filesScanned} text file(s)`);
    return 1;
  }
  console.log(`[secret-scan] passed: ${filesScanned} text file(s) scanned`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runCli();
