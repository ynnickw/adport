import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkVersions } from './release-utils.mjs';

const { version, packages } = checkVersions();
const temporary = mkdtempSync(path.join(os.tmpdir(), 'adport-packages-'));
try {
  for (const { folder, manifest } of packages) {
    execFileSync('pnpm', ['pack', '--pack-destination', temporary], { cwd: folder, stdio: 'pipe' });
    console.log(`Packed ${manifest.name}@${version}`);
  }
  const tarballs = readdirSync(temporary).filter((file) => file.endsWith('.tgz')).map((file) => path.join(temporary, file));
  assert.equal(tarballs.length, packages.length);
  for (const tarball of tarballs) {
    const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
    for (const entry of entries) assert(/^package\/(dist\/|package\.json$|README\.md$|LICENSE$)/.test(entry), `Unexpected packed file: ${entry}`);
    assert(entries.includes('package/LICENSE'), `${tarball}: missing LICENSE`);
    assert(entries.includes('package/README.md'), `${tarball}: missing README`);
    const packed = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
    for (const range of Object.values(packed.dependencies ?? {})) assert(!range.startsWith('workspace:'), `${packed.name}: unresolved workspace dependency`);
    const targets = [packed.main, packed.types, ...Object.values(packed.bin ?? {})].filter(Boolean);
    for (const target of targets) assert(entries.includes(`package/${target.replace(/^\.\//, '')}`), `${packed.name}: missing entry point ${target}`);
  }
  // Use a fresh home and a minimal environment so local provider credentials cannot be discovered.
  const env = { PATH: process.env.PATH, HOME: temporary, ADPORT_HOME: path.join(temporary, 'state'), CI: 'true', SystemRoot: process.env.SystemRoot };
  execFileSync('npm', ['install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--userconfig=/dev/null', ...tarballs], { env, stdio: 'pipe' });
  const cli = path.join(temporary, 'node_modules', 'adport', 'dist', 'index.js');
  const run = (args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' }).trim();
  assert.equal(run(['--version']), version);
  const tools = JSON.parse(run(['tools', 'list', '--json']));
  assert(tools.some((tool) => tool.name === 'accounts_list'));
  const disconnected = spawnSync(process.execPath, [cli, 'accounts', '--json'], { env, encoding: 'utf8' });
  assert.notEqual(disconnected.status, 0);
  assert.match(disconnected.stderr, /NOT_CONNECTED/);
  assert(JSON.parse(run(['--demo', 'accounts', '--json'])).length > 0);
  assert(JSON.parse(run(['--demo', 'report', '--json'])).rows.length > 0);
  run(['--demo', 'audit', 'run']);
  console.log(`Isolated install passed: ${packages.length} tarballs, CLI version, fail-closed reads, synthetic reports and audit.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
