import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkVersions, isNewerVersion, readJson, releaseVersion, root } from './release-utils.mjs';

const version = releaseVersion(process.argv[2] ?? '');
const current = checkVersions();
if (!isNewerVersion(version, current.version)) throw new Error(`Version ${version} must be newer than ${current.version}.`);
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) {
  throw new Error('Start from a clean worktree so the release changes can be reviewed separately.');
}
const notes = path.join(root, 'docs', 'releases', `v${version}.md`);
if (existsSync(notes)) throw new Error(`Release notes already exist: ${notes}`);
for (const file of [path.join(root, 'package.json'), ...current.packages.map(({ folder }) => path.join(folder, 'package.json'))]) {
  const manifest = readJson(file);
  manifest.version = version;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
writeFileSync(notes, `# v${version}\n\n## Changes\n\nDescribe user-visible changes and link the relevant pull requests.\n\n## Upgrade notes\n\nDocument compatibility changes, required actions, and provider limitations.\n\n## Validation\n\nRecord local checks, CI results, and skipped integration tests. Distinguish contract tests from live provider verification.\n`);
console.log(`Prepared ${version}. Edit docs/releases/v${version}.md, run the release checks, and open a signed-off release PR. No tag was created or package published.`);
