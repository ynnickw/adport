import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function hasSignoff(name, email, message) {
  const expected = `${name} <${email}>`.toLowerCase();
  return message.split('\n').some((line) => line.replace(/^Signed-off-by:\s*/i, '').trim().toLowerCase() === expected && /^Signed-off-by:/i.test(line));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.env.DCO_BASE;
  const head = process.env.DCO_HEAD;
  if (![base, head].every((sha) => /^[a-f\d]{40}$/i.test(sha ?? ''))) throw new Error('DCO_BASE and DCO_HEAD must be full commit SHAs.');
  const commits = execFileSync('git', ['rev-list', '--no-merges', `${base}..${head}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const failures = [];
  for (const sha of commits) {
    const [name, email, ...body] = execFileSync('git', ['show', '-s', '--format=%an%n%ae%n%B', sha], { encoding: 'utf8' }).split('\n');
    if (/^(?:dependabot|github-actions)\[bot\]$/.test(name) && /@users\.noreply\.github\.com$/.test(email)) continue;
    if (!hasSignoff(name, email, body.join('\n'))) failures.push(sha.slice(0, 12));
  }
  if (failures.length) throw new Error(`Missing author DCO sign-off in: ${failures.join(', ')}. See CONTRIBUTING.md.`);
  console.log(`DCO check passed (${commits.length} non-merge commits).`);
}
