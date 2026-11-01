import { execFileSync, spawnSync } from 'node:child_process';
import { checkVersions, registryHasVersion, releaseChannel } from './release-utils.mjs';

const { version, packages } = checkVersions(undefined, process.env.RELEASE_TAG);
if (!process.env.RELEASE_TAG || !process.env.NODE_AUTH_TOKEN) throw new Error('Release tag and npm authentication are required.');
const anonymousEnv = { ...process.env };
delete anonymousEnv.NODE_AUTH_TOKEN;
delete anonymousEnv.NPM_TOKEN;
for (const { folder, manifest } of packages) {
  const result = spawnSync('npm', ['view', `${manifest.name}@${version}`, 'version', '--json', '--registry=https://registry.npmjs.org', '--userconfig=/dev/null'], { encoding: 'utf8', env: anonymousEnv });
  if (registryHasVersion(result, version)) {
    console.log(`Already published: ${manifest.name}@${version}`);
    continue;
  }
  execFileSync('pnpm', ['publish', '--access', 'public', '--tag', releaseChannel(version), '--provenance', '--no-git-checks'], { cwd: folder, stdio: 'inherit' });
}
