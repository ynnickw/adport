import { describe, expect, it, vi } from 'vitest';
import type { AdProvider, AnyToolDefinition, NormalizedQuery } from '@adport/core';
import { AccountScopedProvider, createAccountScopeAuthorizer } from '@/lib/cloud/account-scope';

function provider(): AdProvider {
  return {
    id: 'google',
    capabilities: () => ({ serverDryRun: true }),
    listAccounts: vi.fn(async () => [
      { provider: 'google', id: '1234567890', name: 'Active' },
      { provider: 'google', id: '9999999999', name: 'Inactive' },
    ]),
    report: vi.fn(async (query: NormalizedQuery) => ({
      rows: (query.accountIds ?? []).map((accountId) => ({
        provider: 'google', accountId, entity: { level: 'campaign' as const, id: 'c1', name: 'Campaign' }, metrics: { spend: 1 },
      })),
    })),
    previewWrite: vi.fn(async () => ({ summary: 'preview', changes: [], coercions: [], budgetDeltas: [], serverValidated: true })),
    applyWrite: vi.fn(async () => ({ applied: true as const, resourceIds: ['c1'] })),
  };
}

describe('AccountScopedProvider', () => {
  it('filters broad reads to active accounts', async () => {
    const raw = provider();
    const scoped = new AccountScopedProvider(raw, new Set(['1234567890']));
    await expect(scoped.listAccounts()).resolves.toEqual([{ provider: 'google', id: '1234567890', name: 'Active' }]);
    await scoped.report({ level: 'campaign', metrics: ['spend'], dateRange: 'last_7_days' });
    expect(raw.report).toHaveBeenCalledWith(expect.objectContaining({ accountIds: ['1234567890'] }));
  });

  it('rejects inactive account reads and writes before the provider call', async () => {
    const raw = provider();
    const scoped = new AccountScopedProvider(raw, new Set(['1234567890']));
    await expect(scoped.report({ accountIds: ['9999999999'], level: 'campaign', metrics: ['spend'], dateRange: 'last_7_days' }))
      .rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    await expect(scoped.previewWrite({ tool: 'google_set_budget', provider: 'google', accountId: '9999999999', kind: 'update', payload: {} }, { forcePausedCreation: true }))
      .rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(raw.previewWrite).not.toHaveBeenCalled();
  });
});

describe('createAccountScopeAuthorizer', () => {
  const googleTool = { name: 'google_gaql', namespace: 'google' } as AnyToolDefinition;

  it('normalizes Google account ids while guarding concrete provider tools', () => {
    const authorize = createAccountScopeAuthorizer({ google: new Set(['1234567890']) });
    expect(() => authorize(googleTool, { customer_id: '123-456-7890' })).not.toThrow();
    expect(() => authorize(googleTool, { customer_id: '999-999-9999' })).toThrow(/not active/);
  });
});
