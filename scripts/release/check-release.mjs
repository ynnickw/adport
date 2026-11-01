import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { checkVersions, root } from './release-utils.mjs';

const tag = process.argv[2];
const { version, packages } = checkVersions(root, tag);
for (const { folder, manifest } of packages) {
  assert.equal(manifest.license, 'Apache-2.0', `${manifest.name}: license`);
  assert.equal(manifest.engines?.node, '>=22.13', `${manifest.name}: Node.js requirement`);
  assert.equal(manifest.repository?.url, 'git+https://github.com/ynnickw/adport.git', `${manifest.name}: repository`);
  assert.equal(manifest.repository?.directory, path.relative(root, folder).split(path.sep).join('/'), `${manifest.name}: repository directory`);
  assert.equal(manifest.bugs?.url, 'https://github.com/ynnickw/adport/issues', `${manifest.name}: issue tracker`);
  assert.equal(manifest.publishConfig?.access, 'public', `${manifest.name}: publish access`);
  assert.deepEqual(manifest.files, ['dist'], `${manifest.name}: publish allowlist`);
  assert(existsSync(path.join(folder, 'README.md')), `${manifest.name}: package README`);
}
if (tag) assert(existsSync(path.join(root, 'docs', 'releases', `${tag}.md`)), `Missing release notes for ${tag}`);
console.log(`Release manifests valid: ${packages.length} public packages at ${version}${tag ? ` (${tag})` : ''}.`);
