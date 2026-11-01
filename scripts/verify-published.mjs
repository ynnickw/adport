import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, releaseVersion } from './release-utils.mjs';

const version = releaseVersion(process.argv[2] ?? '');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'adport-published-'));
const env = { PATH: process.env.PATH, HOME: temporary, ADPORT_HOME: path.join(temporary, 'state'), CI: 'true', SystemRoot: process.env.SystemRoot };
try {
  execFileSync('npm', ['install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--userconfig=/dev/null', `adport@${version}`], { env, stdio: 'pipe' });
  const cli = path.join(temporary, 'node_modules', 'adport', 'dist', 'index.js');
  const run = (args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' }).trim();
  assert.equal(run(['--version']), version);
  const manifest = readJson(path.join(temporary, 'node_modules', 'adport', 'package.json'));
  for (const name of Object.keys(manifest.dependencies).filter((name) => name.startsWith('@adport/'))) {
    assert.equal(readJson(path.join(temporary, 'node_modules', name, 'package.json')).version, version, name);
  }
  const disconnected = spawnSync(process.execPath, [cli, 'accounts', '--json'], { env, encoding: 'utf8' });
  assert.notEqual(disconnected.status, 0);
  assert.match(disconnected.stderr, /NOT_CONNECTED/);
  assert(JSON.parse(run(['--demo', 'accounts', '--json'])).length > 0);
  assert(JSON.parse(run(['--demo', 'report', '--json'])).rows.length > 0);
  console.log(`Public npm install verified: adport@${version}, matching workspace dependencies, fail-closed reads and demo reports.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
