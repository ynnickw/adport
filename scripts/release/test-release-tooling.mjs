import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkVersions, isNewerVersion, publicPackages, registryHasVersion, releaseChannel, releaseVersion } from './release-utils.mjs';
import { hasSignoff } from '../repository/check-dco.mjs';
import { publishPackages } from './publish-packages.mjs';
import { verifyPublished } from './verify-published.mjs';
import { isExistingVersionConflict, retryRegistry } from './registry-retry.mjs';

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
  for (const folder of ['scripts/release', 'packages/core', 'apps/cloud', 'docs/releases']) mkdirSync(path.join(directory, folder), { recursive: true });
  for (const file of ['prepare-release.mjs', 'release-utils.mjs']) cpSync(new URL(file, import.meta.url), path.join(directory, 'scripts/release', file));
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
  const prepare = (version) => spawnSync(process.execPath, [path.join(directory, 'scripts/release/prepare-release.mjs'), version], { cwd: directory, encoding: 'utf8' });
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

const missingVersion = () => ({ status: 1, stdout: '{"error":{"code":"E404"}}', stderr: '' });
const publishedVersion = (version = '1.2.3') => ({ status: 0, stdout: JSON.stringify(version), stderr: '' });
const npmFailure = (code) => ({ status: 1, stdout: '', stderr: `npm error code ${code}\n` });
const stagedConflict = () => ({ status: 1, stdout: '[E409] 409 Conflict - Cannot publish over previously staged version "1.2.3".', stderr: '' });
const packageFixture = (name) => ({ folder: `/fixture/${name}`, manifest: { name } });
const publisherEnv = { PATH: process.env.PATH, NODE_AUTH_TOKEN: 'test-only', NPM_TOKEN: 'test-only' };
function fakeClock(timeoutMs = 15 * 60 * 1000) {
  let elapsed = 0;
  const pauses = [];
  return { timeoutMs, now: () => elapsed, wait: async (pause) => { pauses.push(pause); elapsed += pause; }, pauses, log: () => {} };
}

test('a staged-version conflict waits through an eight-minute visibility delay without publishing twice', async () => {
  const clock = fakeClock();
  const writes = [];
  await publishPackages({
    version: '1.2.3', packages: [packageFixture('@adport/core'), packageFixture('adport')], env: publisherEnv, ...clock,
    run(command, args, options) {
      if (command === 'npm') {
        assert.equal(options.env.NODE_AUTH_TOKEN, undefined);
        assert.equal(options.env.NPM_TOKEN, undefined);
        assert(args.includes('--prefer-online'));
        assert(args.includes('--fetch-retries=0'));
        return args[1] === '@adport/core@1.2.3' && clock.now() >= 8 * 60 * 1000 ? publishedVersion() : missingVersion();
      }
      writes.push(options.cwd);
      assert(args.includes('--provenance'));
      return options.cwd.endsWith('/@adport/core') ? stagedConflict() : { status: 0 };
    },
  });
  assert.deepEqual(writes, ['/fixture/@adport/core', '/fixture/adport']);
  assert(clock.now() >= 8 * 60 * 1000);
  assert(Math.max(...clock.pauses) <= 30000);
});

test('an invisible staged version stops at its deadline without another publish request', async () => {
  const clock = fakeClock(10000);
  let writes = 0;
  await assert.rejects(publishPackages({
    version: '1.2.3', packages: [packageFixture('adport')], env: publisherEnv, ...clock,
    run(command) { if (command === 'npm') return missingVersion(); writes += 1; return stagedConflict(); },
  }), /Timed out waiting for adport@1.2.3/);
  assert.equal(clock.now(), 10000);
  assert.equal(writes, 1);
});

test('transient lookup errors retry reads, then skip the confirmed public version', async () => {
  const clock = fakeClock();
  let reads = 0;
  let writes = 0;
  await publishPackages({
    version: '1.2.3', packages: [packageFixture('adport')], env: publisherEnv, ...clock,
    run(command) {
      if (command !== 'npm') { writes += 1; return { status: 0 }; }
      reads += 1;
      return reads < 3 ? npmFailure(reads === 1 ? 'E429' : 'ECONNRESET') : publishedVersion();
    },
  });
  assert.deepEqual(clock.pauses, [2000, 4000]);
  assert.equal(writes, 0);
});

test('authentication and malformed lookup responses never turn into a publish request', async () => {
  for (const result of [npmFailure('E401'), npmFailure('E403'), { status: 0, stdout: 'not JSON' }, publishedVersion('9.9.9')]) {
    const clock = fakeClock();
    let writes = 0;
    await assert.rejects(publishPackages({
      version: '1.2.3', packages: [packageFixture('adport')], env: publisherEnv, ...clock,
      run(command) { if (command === 'npm') return result; writes += 1; return { status: 0 }; },
    }), /Registry lookup/);
    assert.equal(writes, 0);
    assert.deepEqual(clock.pauses, []);
  }
});

test('unconfirmed write errors fail without retrying publication or continuing to dependent packages', async () => {
  for (const result of [npmFailure('E403'), npmFailure('ECONNRESET'), { status: 1, stdout: '[E409] Unrelated conflict' }]) {
    const clock = fakeClock();
    let writes = 0;
    await assert.rejects(publishPackages({
      version: '1.2.3', packages: [packageFixture('@adport/core'), packageFixture('adport')], env: publisherEnv, ...clock,
      run(command) { if (command === 'npm') return missingVersion(); writes += 1; return result; },
    }), /Publishing @adport\/core/);
    assert.equal(writes, 1);
    assert.deepEqual(clock.pauses, []);
  }
});

test('only an explicit existing-version conflict permits visibility recovery', () => {
  assert(isExistingVersionConflict(stagedConflict()));
  assert(isExistingVersionConflict({ status: 1, stderr: 'npm error code E403\nnpm error You cannot publish over the previously published versions: 1.2.3.' }));
  assert(!isExistingVersionConflict(npmFailure('E403')));
  assert(!isExistingVersionConflict({ status: 1, stdout: '[E409] Unrelated conflict' }));
});

test('prerelease publication retains its next tag during recovery changes', async () => {
  const calls = [];
  await publishPackages({
    version: '1.2.3-rc.1', packages: [packageFixture('adport')], env: publisherEnv, ...fakeClock(),
    run(command, args) { if (command === 'npm') return missingVersion(); calls.push(args); return { status: 0 }; },
  });
  assert.equal(calls[0][calls[0].indexOf('--tag') + 1], 'next');
});

function installFixture(directory, { cliVersion = '1.2.3', dependencyVersion = '1.2.3' } = {}) {
  const cli = path.join(directory, 'node_modules/adport');
  const core = path.join(directory, 'node_modules/@adport/core');
  mkdirSync(path.join(cli, 'dist'), { recursive: true });
  mkdirSync(core, { recursive: true });
  writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@adport/core': '1.2.3' } }));
  writeFileSync(path.join(core, 'package.json'), JSON.stringify({ version: dependencyVersion }));
  writeFileSync(path.join(cli, 'dist/index.js'), `
    const args = process.argv.slice(2);
    if (args[0] === '--version') console.log(${JSON.stringify(cliVersion)});
    else if (args[0] === 'accounts') { console.error('NOT_CONNECTED'); process.exitCode = 1; }
    else if (args[1] === 'accounts') console.log('[{"id":"synthetic"}]');
    else if (args[1] === 'report') console.log('{"rows":[{"spend":1}]}');
  `);
}

test('public verification waits for missing metadata and archives with fresh isolated installs', async () => {
  const clock = fakeClock();
  const homes = [];
  await verifyPublished('1.2.3', {
    ...clock,
    run(command, args, options) {
      if (command !== 'npm') return spawnSync(command, args, options);
      for (const previous of homes) assert(!existsSync(previous));
      homes.push(options.env.HOME);
      assert.equal(options.env.ADPORT_HOME, path.join(options.env.HOME, 'state'));
      assert.equal(options.env.NODE_AUTH_TOKEN, undefined);
      assert.equal(options.env.NPM_TOKEN, undefined);
      assert.equal(options.env.NPM_CONFIG_USERCONFIG, undefined);
      assert(args.includes('--ignore-scripts'));
      assert(args.includes('--userconfig=/dev/null'));
      if (clock.now() < 8 * 60 * 1000) return npmFailure(homes.length < 3 ? 'ETARGET' : 'E404');
      installFixture(options.env.HOME);
      return { status: 0 };
    },
  });
  assert(clock.now() >= 8 * 60 * 1000);
  assert.equal(new Set(homes).size, homes.length);
  assert(homes.every((home) => !existsSync(home)));
});

test('public verification retries transient downloads but fails immediately on authentication or integrity errors', async () => {
  for (const code of ['E401', 'E403', 'EINTEGRITY']) {
    const clock = fakeClock();
    let attempts = 0;
    let home;
    await assert.rejects(verifyPublished('1.2.3', {
      ...clock,
      run(command, args, options) { attempts += 1; home = options.env.HOME; return npmFailure(code); },
    }), new RegExp(code));
    assert.equal(attempts, 1);
    assert(!existsSync(home));
    assert.deepEqual(clock.pauses, []);
  }
  const clock = fakeClock();
  let installs = 0;
  await verifyPublished('1.2.3', {
    ...clock,
    run(command, args, options) {
      if (command !== 'npm') return spawnSync(command, args, options);
      if (++installs === 1) return npmFailure('E503');
      installFixture(options.env.HOME);
      return { status: 0 };
    },
  });
  assert.equal(installs, 2);
});

test('public verification never retries an installed CLI or internal dependency mismatch', async () => {
  for (const fixture of [{ cliVersion: '9.9.9' }, { dependencyVersion: '9.9.9' }]) {
    const clock = fakeClock();
    let installs = 0;
    let home;
    await assert.rejects(verifyPublished('1.2.3', {
      ...clock,
      run(command, args, options) {
        installs += 1; home = options.env.HOME; installFixture(home, fixture); return { status: 0 };
      },
    }), { code: 'ERR_ASSERTION' });
    assert.equal(installs, 1);
    assert(!existsSync(home));
    assert.deepEqual(clock.pauses, []);
  }
});

test('the registry deadline remains bounded and permanent errors are not retried', async () => {
  const clock = fakeClock(10000);
  let attempts = 0;
  await assert.rejects(retryRegistry(() => {
    attempts += 1; throw Object.assign(new Error('Not visible'), { retryable: true });
  }, { description: 'a test release', ...clock }), /Timed out waiting for a test release/);
  assert.equal(clock.now(), 10000);
  assert.equal(attempts, 4);
  const failure = new Error('Invalid release contents');
  await assert.rejects(retryRegistry(() => { throw failure; }, clock), (error) => error === failure);
});
