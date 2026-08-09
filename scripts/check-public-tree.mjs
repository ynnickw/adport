import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const output = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
);
const files = output.split('\0').filter(Boolean);

const forbiddenPath = [
  { test: (file) => file === 'private' || file.startsWith('private/'), reason: 'private workspace material' },
  { test: (file) => /(^|\/)\.env($|\.)/.test(file) && !/\.example$/.test(file), reason: 'environment file' },
  { test: (file) => /(^|\/)(credentials|tokens?)\.json$/i.test(file), reason: 'credential/token store' },
  { test: (file) => /\.(pem|p8|p12|key|keystore)$/i.test(file), reason: 'private key or keystore' },
  { test: (file) => /(^|\/)\.DS_Store$/.test(file), reason: 'OS metadata' },
];

const violations = [];
for (const file of files) {
  for (const rule of forbiddenPath) {
    if (rule.test(file)) violations.push(`${file} (${rule.reason})`);
  }

  let stat;
  try {
    stat = statSync(file);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 2_000_000) continue;
  const content = readFileSync(file, 'utf8');
  if (/-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/.test(content)) {
    violations.push(`${file} (embedded private key material)`);
  }
}

if (violations.length > 0) {
  console.error('Public-tree check failed. Remove or ignore these files before publishing:');
  for (const violation of [...new Set(violations)].sort()) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(`Public-tree check passed (${files.length} tracked or publishable files inspected).`);
