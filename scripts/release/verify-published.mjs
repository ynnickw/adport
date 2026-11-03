import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, releaseVersion } from './release-utils.mjs';
import { registryCommandError, registryFetchArgs, retryRegistry } from './registry-retry.mjs';

export async function verifyPublished(value, { run = spawnSync, log = console.log, ...retryOptions } = {}) {
  const version = releaseVersion(value);
  let temporary;
  let env;
  try {
    await retryRegistry(() => {
      if (temporary) rmSync(temporary, { recursive: true, force: true });
      temporary = mkdtempSync(path.join(os.tmpdir(), 'adport-published-'));
      // Every attempt gets a fresh credential-free home, cache, and dependency resolution.
      env = { PATH: process.env.PATH, HOME: temporary, ADPORT_HOME: path.join(temporary, 'state'), CI: 'true', SystemRoot: process.env.SystemRoot };
      const installed = run('npm', ['install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund', '--json', ...registryFetchArgs, `adport@${version}`], { env, encoding: 'utf8', timeout: 120000 });
      if (installed.status !== 0 || installed.error) throw registryCommandError(installed, `Public installation of adport@${version}`, { missingIsTransient: true });
    }, { description: `a public installation of adport@${version}`, log, ...retryOptions });
    const cli = path.join(temporary, 'node_modules', 'adport', 'dist', 'index.js');
    const execute = (args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 30000 }).trim();
    assert.equal(execute(['--version']), version);
    const manifest = readJson(path.join(temporary, 'node_modules', 'adport', 'package.json'));
    for (const name of Object.keys(manifest.dependencies).filter((name) => name.startsWith('@adport/'))) {
      assert.equal(readJson(path.join(temporary, 'node_modules', name, 'package.json')).version, version, name);
    }
    const disconnected = run(process.execPath, [cli, 'accounts', '--json'], { env, encoding: 'utf8', timeout: 30000 });
    assert.notEqual(disconnected.status, 0);
    assert.match(disconnected.stderr, /NOT_CONNECTED/);
    assert(JSON.parse(execute(['--demo', 'accounts', '--json'])).length > 0);
    assert(JSON.parse(execute(['--demo', 'report', '--json'])).rows.length > 0);
    log(`Public npm install verified: adport@${version}, matching workspace dependencies, fail-closed reads and demo reports.`);
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await verifyPublished(process.argv[2] ?? '');
