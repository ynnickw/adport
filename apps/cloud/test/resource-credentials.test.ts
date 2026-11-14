import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { resourceSecretKey } from '@adport/core';
import { PostgresResourceSecretStore } from '@/lib/cloud/resource-credentials';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import { resetEnvForTests } from '@/lib/env';

const mocks = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: () => mocks.sql }));
const scope = { provider: 'spotify', accountId: 'account', businessId: 'business', resourceId: 'integration', credentialId: 'token' };
const principal = { organizationId: 'project-a', role: 'owner' as const, scopes: ['tools:read', 'tools:write'] };
const store = () => new PostgresResourceSecretStore(principal, 'spotify', new Set(['account']));
const aad = `resource-credential:v1:project-a:${resourceSecretKey(scope)}`;
beforeEach(() => { vi.stubEnv('ADPORT_CLOUD_ENCRYPTION_KEY', Buffer.alloc(32, 5).toString('base64'));resetEnvForTests();mocks.sql.mockReset(); });
afterEach(() => { vi.unstubAllEnvs();resetEnvForTests(); });

describe('hosted resource credential vault', () => {
  it('encrypts with project and complete resource scope, using an immutable insert', async () => {
    mocks.sql.mockResolvedValue([{ resourceKey: resourceSecretKey(scope) }]);
    expect(await store().putIfAbsent(scope, 'native-secret')).toBe(true);
    const [sql, project, key, provider, account, business, resource, credential, ciphertext] = mocks.sql.mock.calls[0]!;
    expect(sql.join('?')).toMatch(/on conflict \(organization_id, resource_key\) do nothing/);
    expect([project, key, provider, account, business, resource, credential]).toEqual(['project-a', resourceSecretKey(scope), 'spotify', 'account', 'business', 'integration', 'token']);
    expect(ciphertext).not.toContain('native-secret');expect(decryptSecret(ciphertext, aad)).toEqual({ secret: 'native-secret' });
    expect(() => decryptSecret(ciphertext, aad.replace('project-a', 'project-b'))).toThrow();
    expect(() => decryptSecret(ciphertext, `resource-credential:v1:project-a:${resourceSecretKey({ ...scope, resourceId: 'other' })}`)).toThrow();
  });
  it('does not replace an existing credential', async () => { mocks.sql.mockResolvedValue([]);expect(await store().putIfAbsent(scope, 'replacement')).toBe(false); });
  it('reads and deletes using both project and resource scope', async () => {
    mocks.sql.mockResolvedValueOnce([{ ciphertext: encryptSecret({ secret: 'native-secret' }, aad) }]).mockResolvedValueOnce([{ resourceKey: resourceSecretKey(scope) }]);
    expect(await store().get(scope)).toBe('native-secret');expect(await store().delete(scope)).toBe(true);
    expect(mocks.sql.mock.calls.every(([, project, key]) => project === 'project-a' && key === resourceSecretKey(scope))).toBe(true);
  });
  it('answers metadata reads without selecting or decrypting ciphertext', async () => {
    mocks.sql.mockResolvedValue([{ present: true }]);expect(await store().has(scope)).toBe(true);
    expect(mocks.sql.mock.calls[0]![0].join('?')).not.toContain('ciphertext');
  });
  it('blocks foreign accounts/providers, viewers and read-only secret access before SQL', async () => {
    await expect(store().get({ ...scope, accountId: 'other' })).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    await expect(store().putIfAbsent({ ...scope, provider: 'meta' }, 'secret')).rejects.toThrow(/scope/);
    const reader = new PostgresResourceSecretStore({ ...principal, scopes: ['tools:read'] }, 'spotify', new Set(['account']));
    await expect(reader.get(scope)).rejects.toThrow(/not permitted/);await expect(reader.delete(scope)).rejects.toThrow(/not permitted/);
    const viewer = new PostgresResourceSecretStore({ ...principal, role: 'viewer' }, 'spotify', new Set(['account']));
    await expect(viewer.putIfAbsent(scope, 'secret')).rejects.toThrow(/not permitted/);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
