import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileResourceSecretStore, resourceSecretKey, type ResourceSecretScope } from '../src/credentials/resources.js';

const scope = { provider: 'spotify', accountId: 'account', businessId: 'business', resourceId: 'integration', credentialId: 'token' };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(path.join(tmpdir(), 'adport-resource-secrets-'));roots.push(root);return { root, store: new FileResourceSecretStore(root) }; }

describe('local resource credential store', () => {
  it('publishes private files atomically without overwriting another writer', async () => {
    const { root, store } = await fixture();
    const results = await Promise.all([store.putIfAbsent(scope, 'first-secret'), store.putIfAbsent(scope, 'other-secret')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.get(scope)).toBe(results[0] ? 'first-secret' : 'other-secret');
    expect(await store.has(scope)).toBe(true);
    const files = await readdir(root);expect(files).toEqual([resourceSecretKey(scope) + '.json']);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(root, files[0]!))).mode & 0o777).toBe(0o600);
    expect(await store.putIfAbsent(scope, 'replacement')).toBe(false);
  });
  it.each(['provider', 'accountId', 'businessId', 'resourceId', 'credentialId'] as const)('separates the %s boundary', async field => {
    const { store } = await fixture();await store.putIfAbsent(scope, 'secret');
    const other = { ...scope, [field]: 'other' };
    expect(await store.get(other)).toBeUndefined();expect(await store.delete(other)).toBe(false);expect(await store.get(scope)).toBe('secret');
  });
  it('removes only the selected local copy and returns absence honestly', async () => {
    const { store } = await fixture();expect(await store.has(scope)).toBe(false);
    await store.putIfAbsent(scope, 'secret');expect(await store.delete(scope)).toBe(true);expect(await store.delete(scope)).toBe(false);expect(await store.get(scope)).toBeUndefined();
  });
  it('uses deterministic ordered scope keys rather than path input', async () => {
    const { root, store } = await fixture(), nested = { ...scope, credentialId: '../../outside' };
    await store.putIfAbsent(nested, 'secret');expect((await readdir(root))[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(resourceSecretKey({ credentialId: 'token', resourceId: 'integration', businessId: 'business', accountId: 'account', provider: 'spotify' })).toBe(resourceSecretKey(scope));
    expect(() => resourceSecretKey({ ...scope, accountId: '' })).toThrow(/Invalid/);
    expect(() => resourceSecretKey({ ...scope, credentialId: '\n' })).toThrow(/Invalid/);
    expect(JSON.parse(await readFile(path.join(root, resourceSecretKey(nested) + '.json'), 'utf8')).scope).toEqual(nested);
  });
  it('does not expose secret-bearing file fragments in parse errors', async () => {
    const { root, store } = await fixture();await store.putIfAbsent(scope, 'private-secret-fragment');
    await writeFile(path.join(root, resourceSecretKey(scope) + '.json'), '{"secret":"private-secret-fragment" broken');
    const error = await store.get(scope).catch(error => error);
    expect(error.message).toBe('Private resource credential could not be read.');expect(String(error.stack)).not.toContain('private-secret-fragment');
  });
});
