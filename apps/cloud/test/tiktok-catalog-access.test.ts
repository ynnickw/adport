import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogGrant, requireCatalogAccess } from '@adport/provider-tiktok';
import { PostgresTikTokCatalogAccessStore } from '@/lib/cloud/tiktok-catalog-access';
const mocks = vi.hoisted(() => ({ sql: vi.fn(), begin: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: () => Object.assign(mocks.sql, { begin: mocks.begin }) }));
const scope = { accountId: '123', businessId: '456', resourceId: '789', kind: 'catalog' as const }, principal = { organizationId: '203c14b1-c908-4632-9aa7-1be5de4ae9b0', userId: 'owner', role: 'owner' as const, scopes: ['tools:read', 'tools:write', 'connections:manage'] };
const row = { accountId: '123', businessId: '456', resourceKind: 'catalog', resourceId: '789', accessMode: 'read', revision: '1' };
const store = () => new PostgresTikTokCatalogAccessStore(principal, new Set(['123']), true);
beforeEach(() => {
  vi.resetAllMocks();mocks.begin.mockImplementation(async run => run(mocks.sql));
  mocks.sql.mockImplementation(async (parts: TemplateStringsArray) => {
    const query = parts.join('?');
    if (query.includes('select account.enabled')) return [{ enabled: true, status: 'connected', accountSelectionId: null }];
    if (query.includes('from private.tiktok_catalog_access')) return [row];
    return [];
  });
});
describe('Postgres project/catalog grant boundary', () => {
  it('keeps all five scope coordinates bound in SQL and returns exact read/write permissions', async () => {
    const result = await store().get(scope);expect(result).toMatchObject({ scope, mode: 'read', revision: 1 });
    const call = mocks.sql.mock.calls.at(-1)!;expect(call.slice(1)).toEqual([principal.organizationId, '123', '456', 'catalog', '789']);expect(call[0].join('?')).toContain("provider = 'tiktok'");await expect(requireCatalogAccess(store(), scope, true)).rejects.toThrow('write access');
  });
  it('rejects out-of-scope accounts and OAuth/API-key/member administrative writes before SQL', async () => {
    await expect(new PostgresTikTokCatalogAccessStore(principal, new Set()).get(scope)).rejects.toThrow('not enabled');
    for (const patch of [{ clientId: 'oauth' }, { apiKeyId: 'key' }, { oauthTokenId: 'token' }, { role: 'member' as const }, { role: 'viewer' as const }]) {
      const target = new PostgresTikTokCatalogAccessStore({ ...principal, ...patch }, new Set(['123']), true);expect(target.canManage).toBe(false);await expect(target.compareAndSet(scope, catalogGrant(scope).hash, 'write')).rejects.toThrow('signed-in project owner');
    }expect(mocks.sql).not.toHaveBeenCalled();
  });
  it('allows Reader-plan owner settings while independently denying native writes', async () => {
    const target = new PostgresTikTokCatalogAccessStore({ ...principal, scopes: ['tools:read', 'connections:manage'] }, new Set(['123']), true);expect(target.canManage).toBe(true);expect(target.canWrite).toBe(false);await expect(requireCatalogAccess(target, scope, true)).rejects.toThrow('cannot modify');
  });
  it('permits inactive-account grant inspection for owners but denies native access, including owner misuse', async () => {
    mocks.sql.mockImplementation(async (parts: TemplateStringsArray) => parts.join('?').includes('select account.enabled') ? [{ enabled: false, status: 'revoked', accountSelectionId: null }] : [row]);
    expect((await store().get(scope)).mode).toBe('read');await expect(requireCatalogAccess(store(), scope)).rejects.toThrow('disabled, disconnected');
    const agent = new PostgresTikTokCatalogAccessStore(principal, new Set(['123']));await expect(agent.get(scope)).rejects.toThrow('disabled, disconnected');
  });
  it('locks project, connection and account before grant compare-and-set, with revision checked again', async () => {
    mocks.sql.mockImplementation(async (parts: TemplateStringsArray) => {
      const q = parts.join('?');if (q.includes('select account.enabled')) return [{ enabled: true, status: 'connected', accountSelectionId: null }];if (q.includes('for key share')) return [{ id: principal.organizationId }];if (q.includes('for update of connection')) return [{ id: 'connection' }];if (q.includes('enabled = true) for update')) return [{ accountId: '123' }];if (q.includes('from private.tiktok_catalog_access')) return [row];if (q.includes('insert into private.tiktok_catalog_access')) return [{ ...row, accessMode: 'write', revision: '2' }];return [];
    });const current = catalogGrant(scope, 'read', 1), result = await store().compareAndSet(scope, current.hash, 'write');expect(result).toMatchObject({ mode: 'write', revision: 2 });expect(mocks.begin).toHaveBeenCalledTimes(1);const queries = mocks.sql.mock.calls.map(call => call[0].join('?'));expect(queries.some(value => value.includes('for key share'))).toBe(true);expect(queries.some(value => value.includes('for update of connection'))).toBe(true);expect(queries.at(-1)).toContain('where private.tiktok_catalog_access.revision =');
  });
});
