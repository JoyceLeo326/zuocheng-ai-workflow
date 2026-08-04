import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, basename } from 'node:path';
import process, { stderr, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.env', '.html', '.js', '.jsx', '.json', '.md', '.mjs',
  '.ps1', '.py', '.sh', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);
const TEXT_NAMES = new Set(['.gitignore', 'Dockerfile']);
const compatiblePrefix = String.fromCharCode(115, 107, 45);

const RULES = [
  {
    id: 'openai-compatible',
    expression: new RegExp(`(?<![A-Za-z])${compatiblePrefix}[A-Za-z0-9_-]{4,}`, 'u'),
  },
  { id: 'google-ai', expression: /AIza[0-9A-Za-z_-]{24,}/u },
  { id: 'groq', expression: /gsk_[0-9A-Za-z]{20,}/u },
  { id: 'hugging-face', expression: /hf_[0-9A-Za-z]{20,}/u },
  { id: 'github-token', expression: /gh[pousr]_[0-9A-Za-z]{20,}/u },
];

export function scanText(text) {
  return RULES.filter((rule) => rule.expression.test(text)).map((rule) => rule.id);
}

function trackedTextFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return output
    .split('\0')
    .filter(Boolean)
    .filter((file) => TEXT_EXTENSIONS.has(extname(file).toLowerCase()) || TEXT_NAMES.has(basename(file)));
}

export function scanRepository() {
  const findings = [];
  for (const file of trackedTextFiles()) {
    const rules = scanText(readFileSync(file, 'utf8'));
    if (rules.length) findings.push({ file, rules });
  }
  return findings;
}

function main() {
  const findings = scanRepository();
  if (findings.length) {
    for (const finding of findings) {
      stderr.write(`${finding.file}: ${finding.rules.join(', ')}\n`);
    }
    stderr.write(`Credential-shape gate failed in ${findings.length} tracked file(s); values were not printed.\n`);
    process.exitCode = 1;
    return;
  }
  stdout.write('Credential-shape gate passed.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
