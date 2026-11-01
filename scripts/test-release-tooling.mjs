import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkVersions, isNewerVersion, publicPackages, registryHasVersion, releaseChannel, releaseVersion } from './release-utils.mjs';
import { hasSignoff } from './check-dco.mjs';

test('release versions reject invalid input and route prereleases away from latest', () => {
  for (const version of ['0.6.2', '1.0.0', '1.0.0-rc.0', '1.0.0-beta.2', '1.0.0-alpha.1']) assert.equal(releaseVersion(version), version);
  for (const version of ['v0.6.2', '01.0.0', '1.0', '1.0.0-rc', '1.0.0-rc.01', 'main', '1.0.0;echo unsafe', '1.0.0\n']) assert.throws(() => releaseVersion(version));
  assert.equal(releaseChannel('1.0.0'), 'latest');
  assert.equal(releaseChannel('1.0.0-rc.1'), 'next');
});

test('release validation binds every public package to the tag and orders dependencies first', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'adport-release-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (file, data) => { mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); writeFileSync(path.join(directory, file), JSON.stringify(data)); };
  write('package.json', { private: true, version: '1.2.3' });
  write('packages/a-cli/package.json', { name: 'adport', version: '1.2.3', dependencies: { '@adport/core': 'workspace:*' } });
  write('packages/z-core/package.json', { name: '@adport/core', version: '1.2.3' });
  write('packages/private/package.json', { name: 'private-fixture', version: '0.0.1', private: true });
  assert.deepEqual(publicPackages(directory).map(({ manifest }) => manifest.name), ['@adport/core', 'adport']);
  assert.equal(checkVersions(directory, 'v1.2.3').packages.length, 2);
  assert.throws(() => checkVersions(directory, 'v1.2.4'), /Tag/);
  write('packages/z-core/package.json', { name: '@adport/core', version: '1.2.2' });
  assert.throws(() => checkVersions(directory), /expected version/);
  write('packages/z-core/package.json', { name: '@adport/core', version: '1.2.3', dependencies: { adport: 'workspace:*' } });
  assert.throws(() => publicPackages(directory), /Circular/);
});

test('registry retries skip only published versions and publish only on an explicit 404', () => {
  assert.equal(registryHasVersion({ status: 0, stdout: '"1.2.3"' }, '1.2.3'), true);
  assert.equal(registryHasVersion({ status: 1, stdout: '{"error":{"code":"E404"}}' }, '1.2.3'), false);
  for (const code of ['E401', 'E429', 'ECONNRESET']) assert.throws(() => registryHasVersion({ status: 1, stdout: JSON.stringify({ error: { code } }) }, '1.2.3'), /stopped/);
  assert.throws(() => registryHasVersion({ status: 1, stdout: '' }, '1.2.3'), /stopped/);
  assert.throws(() => registryHasVersion({ status: 0, stdout: '"9.9.9"' }, '1.2.3'), /stopped/);
});

test('DCO requires the commit author sign-off rather than another identity or body mention', () => {
  assert(hasSignoff('A Contributor', 'a@example.test', 'fix: example\n\nSigned-off-by: A Contributor <a@example.test>'));
  assert(!hasSignoff('A Contributor', 'a@example.test', 'Signed-off-by: Someone Else <other@example.test>'));
  assert(!hasSignoff('A Contributor', 'a@example.test', 'Please add Signed-off-by: A Contributor <a@example.test>'));
});


test('release preparation advances versions and preserves private application versions', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'adport-prepare-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const folder of ['scripts', 'packages/core', 'apps/cloud', 'docs/releases']) mkdirSync(path.join(directory, folder), { recursive: true });
  for (const file of ['prepare-release.mjs', 'release-utils.mjs']) cpSync(new URL(file, import.meta.url), path.join(directory, 'scripts', file));
  for (const [file, data] of [
    ['package.json', { private: true, version: '1.2.3' }],
    ['packages/core/package.json', { name: '@adport/core', version: '1.2.3' }],
    ['apps/cloud/package.json', { name: '@adport/cloud', private: true, version: '0.1.0' }],
  ]) writeFileSync(path.join(directory, file), JSON.stringify(data));
  const git = (args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Test Contributor']);
  git(['config', 'user.email', 'test@example.test']);
  git(['add', '.']);
  git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
  const prepare = (version) => spawnSync(process.execPath, [path.join(directory, 'scripts/prepare-release.mjs'), version], { cwd: directory, encoding: 'utf8' });
  assert.notEqual(prepare('1.2.2').status, 0);
  assert.equal(prepare('1.3.0-rc.1').status, 0);
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'packages/core/package.json'))).version, '1.3.0-rc.1');
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'apps/cloud/package.json'))).version, '0.1.0');
  assert(existsSync(path.join(directory, 'docs/releases/v1.3.0-rc.1.md')));
  assert.equal(git(['tag', '--list']).trim(), '');
  assert.notEqual(prepare('1.3.0').status, 0, 'a dirty release worktree must be rejected');
});

test('version progression handles prereleases, stable promotion and downgrades', () => {
  for (const [candidate, current] of [['1.3.0', '1.2.9'], ['1.3.0', '1.3.0-rc.2'], ['1.3.0-beta.0', '1.3.0-alpha.9'], ['1.3.0-rc.2', '1.3.0-rc.1']]) assert(isNewerVersion(candidate, current));
  for (const [candidate, current] of [['1.2.9', '1.3.0'], ['1.3.0-rc.1', '1.3.0'], ['1.3.0', '1.3.0']]) assert(!isNewerVersion(candidate, current));
});
