import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersions, registryHasVersion, releaseChannel } from './release-utils.mjs';
import { isExistingVersionConflict, registryCommandError, registryFetchArgs, registryWaitMs, retryRegistry } from './registry-retry.mjs';

export async function publishPackages({ version, packages, env = process.env, run = spawnSync, log = console.log, now = Date.now, timeoutMs = registryWaitMs, wait }) {
  const channel = releaseChannel(version);
  if (!env.NODE_AUTH_TOKEN) throw new Error('npm authentication is required.');
  const anonymousEnv = { ...env };
  delete anonymousEnv.NODE_AUTH_TOKEN;
  delete anonymousEnv.NPM_TOKEN;
  const deadline = now() + timeoutMs;
  for (const { folder, manifest } of packages) {
    const name = `${manifest.name}@${version}`;
    const readVersion = () => {
      const result = run('npm', ['view', name, 'version', '--json', ...registryFetchArgs], { encoding: 'utf8', env: anonymousEnv, timeout: 30000 });
      try { return registryHasVersion(result, version); } catch {
        throw registryCommandError(result, `Registry lookup for ${name}`);
      }
    };
    const retryOptions = () => ({ description: name, timeoutMs: Math.max(0, deadline - now()), now, wait, log });
    if (await retryRegistry(readVersion, retryOptions())) {
      log(`Already published: ${name}`);
      continue;
    }
    const result = run('pnpm', ['publish', '--access', 'public', '--tag', channel, '--provenance', '--no-git-checks'], { cwd: folder, env, encoding: 'utf8', timeout: 120000 });
    if (result.status === 0 && !result.error) {
      log(`Registry accepted ${name}; public installation still needs verification.`);
      continue;
    }
    if (!isExistingVersionConflict(result)) throw registryCommandError(result, `Publishing ${name}`);
    // A staged version owns this immutable name/version even before public reads see it.
    log(`npm already has ${name}. Waiting for public visibility without another publish request.`);
    await retryRegistry(() => {
      if (readVersion()) return;
      throw Object.assign(new Error(`${name} is not publicly visible yet.`), { retryable: true });
    }, retryOptions());
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { version, packages } = checkVersions(undefined, process.env.RELEASE_TAG);
  if (!process.env.RELEASE_TAG) throw new Error('Release tag is required.');
  await publishPackages({ version, packages });
}
