import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '../src/credentials/store.js';
import { resolveDateRange, rangeDayCount } from '../src/model.js';
import { createContext } from '../src/context.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'adport-test-'));
  process.env.ADPORT_HOME = home;
});

afterEach(() => {
  delete process.env.ADPORT_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('CredentialStore', () => {
  it('round-trips records and keeps the file private (0600)', async () => {
    const store = new CredentialStore();
    await store.set({ provider: 'google', source: 'byo', data: { refresh_token: 'secret' } });
    const record = await store.get('google');
    expect(record?.data.refresh_token).toBe('secret');
    const mode = statSync(path.join(home, 'credentials.json')).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await store.delete('google')).toBe(true);
    expect(await store.get('google')).toBeUndefined();
  });
});

describe('resolveDateRange', () => {
  const now = new Date('2026-08-05T10:00:00Z');

  it('resolves presets', () => {
    expect(resolveDateRange('yesterday', now)).toEqual({ start: '2026-08-04', end: '2026-08-04' });
    expect(resolveDateRange('last_7_days', now)).toEqual({ start: '2026-07-29', end: '2026-08-04' });
    expect(resolveDateRange('this_month', now)).toEqual({ start: '2026-08-01', end: '2026-08-05' });
  });

  it('passes explicit ranges through and counts days inclusively', () => {
    const range = resolveDateRange({ start: '2026-01-01', end: '2026-01-07' }, now);
    expect(rangeDayCount(range)).toBe(7);
  });
});

describe('createContext + ToolRegistry', () => {
  it('fails closed when no provider is connected', async () => {
    const { ctx, registry } = await createContext();
    expect(registry.list().some((tool) => tool.name.startsWith('mock_'))).toBe(false);
    await expect(registry.call('accounts_list', {}, ctx)).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
      message: expect.stringContaining('No ad providers are connected'),
    });
  });

  it('lists accounts and reports through the registry', async () => {
    const { ctx, registry } = await createContext({ includeMock: true });
    const accounts = (await registry.call('accounts_list', {}, ctx)) as { accounts: unknown[] };
    expect(accounts.accounts).toHaveLength(2);

    const report = (await registry.call(
      'report',
      { level: 'campaign', metrics: ['spend', 'clicks'], date_range: 'last_7_days' },
      ctx,
    )) as { rows: Array<{ metrics: Record<string, number> }> };
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows[0]?.metrics.spend).toBeTypeOf('number');
  });

  it('can preserve successful reads when another provider fails', async () => {
    const { ctx, registry } = await createContext({ includeMock: true });
    ctx.providers.register({
      id: 'broken',
      capabilities: () => ({ serverDryRun: false }),
      listAccounts: async () => { throw new Error('broken account read'); },
      report: async () => { throw new Error('broken report read'); },
      previewWrite: async () => { throw new Error('unused'); },
      applyWrite: async () => { throw new Error('unused'); },
    });
    const accounts = await registry.call('accounts_list', { continue_on_error: true }, ctx) as {
      accounts: unknown[]; errors: Array<{ provider: string; message: string }>;
    };
    expect(accounts.accounts).toHaveLength(2);
    expect(accounts.errors).toEqual([{ provider: 'broken', message: 'broken account read' }]);

    const report = await registry.call('report', {
      metrics: ['spend'], continue_on_error: true,
    }, ctx) as { rows: unknown[]; errors: Array<{ provider: string; message: string }> };
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.errors).toEqual([{ provider: 'broken', message: 'broken report read' }]);
  });

  it('rejects invalid tool input with INVALID_INPUT', async () => {
    const { ctx, registry } = await createContext({ includeMock: true });
    await expect(registry.call('report', { metrics: ['nope'] }, ctx)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('adds account currency without mixing provider identities and preserves upstream truncation', async () => {
    const { ctx, registry } = await createContext();
    const listAccounts = vi.fn(async () => [
      { provider: 'google', id: 'same', name: 'EU', currency: 'EUR' },
      { provider: 'meta', id: 'same', name: 'US', currency: 'USD' },
    ]);
    ctx.providers.register({
      id: 'google', capabilities: () => ({ serverDryRun: true }), listAccounts,
      report: async () => ({ truncated: true, rows: [{ provider: 'google', accountId: 'same', entity: { level: 'campaign', id: 'c', name: 'Campaign' }, metrics: { spend: 100 } }] }),
      previewWrite: async () => { throw new Error('unused'); }, applyWrite: async () => { throw new Error('unused'); },
    });
    const report = await registry.call('report', { metrics: ['spend'] }, ctx);
    expect(report).toMatchObject({ rows: [{ currency: 'EUR' }], truncated: true, errors: [], warnings: [], date_range: 'last_7_days' });
    expect(listAccounts).toHaveBeenCalledOnce();
  });

  it('preserves report data when currency metadata fails without returning raw errors or guessing currency', async () => {
    const { ctx, registry } = await createContext();
    ctx.providers.register({
      id: 'google', capabilities: () => ({ serverDryRun: true }),
      listAccounts: async () => { throw new Error('private diagnostic'); },
      report: async () => ({ rows: [{ provider: 'google', accountId: 'one', entity: { level: 'campaign', id: 'c', name: 'Campaign' }, metrics: { spend: 100 } }] }),
      previewWrite: async () => { throw new Error('unused'); }, applyWrite: async () => { throw new Error('unused'); },
    });
    const report = await registry.call('report', {}, ctx) as { rows: object[]; warnings: unknown[] };
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).not.toHaveProperty('currency');
    expect(report.warnings).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('private diagnostic');
  });

  it('routes mixed account selections only to matching providers, reuses metadata, and skips empty providers', async () => {
    const { ctx, registry } = await createContext();
    const reports = new Map<string, ReturnType<typeof vi.fn>>();
    const inventories = new Map<string, ReturnType<typeof vi.fn>>();
    for (const [id, accountId] of [['google', '1234567890'], ['meta', '123'], ['snapchat', 'snap-one'], ['reddit', '']]) {
      const listAccounts = vi.fn(async () => accountId ? [{ provider: id!, id: accountId, name: 'Fixture', currency: 'EUR' }] : []);
      const report = vi.fn(async () => ({ rows: [] }));
      reports.set(id!, report); inventories.set(id!, listAccounts);
      ctx.providers.register({ id: id!, capabilities: () => ({ serverDryRun: false }), listAccounts, report,
        previewWrite: async () => { throw new Error('unused'); }, applyWrite: async () => { throw new Error('unused'); } });
    }
    const result = await registry.call('report', { account_ids: ['123-456-7890', '1234567890', 'act_123', 'snap-one'] }, ctx);
    expect(result).toMatchObject({ rows: [], errors: [] });
    expect(reports.get('google')).toHaveBeenCalledWith(expect.objectContaining({ accountIds: ['1234567890'] }));
    expect(reports.get('meta')).toHaveBeenCalledWith(expect.objectContaining({ accountIds: ['123'] }));
    expect(reports.get('snapchat')).toHaveBeenCalledWith(expect.objectContaining({ accountIds: ['snap-one'] }));
    expect(reports.get('reddit')).not.toHaveBeenCalled();
    for (const lookup of inventories.values()) expect(lookup).toHaveBeenCalledOnce();
  });

  it('does not broaden empty or unresolved account selections and retains explicit provider authorization', async () => {
    const { ctx, registry } = await createContext({ includeMock: true });
    const provider = ctx.providers.get('mock');
    const report = vi.spyOn(provider, 'report');
    expect(await registry.call('report', { account_ids: [] }, ctx)).toMatchObject({ rows: [] });
    await expect(registry.call('report', { account_ids: ['outside'] }, ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(report).not.toHaveBeenCalled();
    expect(await registry.call('report', { account_ids: ['mock-1', 'outside'], continue_on_error: true }, ctx)).toMatchObject({ errors: [{ provider: 'core' }] });
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ accountIds: ['mock-1'] }));
    await registry.call('report', { provider: 'mock', account_ids: ['outside'] }, ctx);
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ accountIds: ['outside'] }));
  });

  it('never reports unscoped after inventory failure during cross-provider account routing', async () => {
    const { ctx, registry } = await createContext({ includeMock: true });
    const report = vi.fn(async () => ({ rows: [] }));
    ctx.providers.register({ id: 'broken', capabilities: () => ({ serverDryRun: false }), report,
      listAccounts: async () => { throw new Error('inventory unavailable'); },
      previewWrite: async () => { throw new Error('unused'); }, applyWrite: async () => { throw new Error('unused'); } });
    const result = await registry.call('report', { account_ids: ['mock-1'], continue_on_error: true }, ctx);
    expect(result).toMatchObject({ errors: [{ provider: 'broken', message: 'inventory unavailable' }] });
    expect(report).not.toHaveBeenCalled();
  });

  it('runs the hosted authorization hook after parsing and before the handler', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const { ctx, registry } = await createContext({
      includeMock: true,
      authorizeToolCall(tool, input) {
        calls.push({ name: tool.name, input });
        if (input.account_id === 'mock-2') throw new Error('account outside tenant scope');
      },
    });
    await registry.call('mock_list_campaigns', { account_id: 'mock-1' }, ctx);
    expect(calls).toEqual([{ name: 'mock_list_campaigns', input: { account_id: 'mock-1' } }]);
    await expect(registry.call('mock_list_campaigns', { account_id: 'mock-2' }, ctx))
      .rejects.toThrow('account outside tenant scope');
  });

  it('runs the full two-step write through the guarded tool', async () => {
    const { ctx, registry } = await createContext({ includeMock: true });
    const first = (await registry.call(
      'mock_set_budget',
      { account_id: 'mock-1', campaign_id: 'c1', daily_budget_micros: 11_000_000 },
      ctx,
    )) as { status: string; pending_operation_id: string };
    expect(first.status).toBe('pending_validation');

    const second = (await registry.call(
      'mock_set_budget',
      {
        account_id: 'mock-1',
        campaign_id: 'c1',
        daily_budget_micros: 11_000_000,
        pending_operation_id: first.pending_operation_id,
      },
      ctx,
    )) as { status: string };
    expect(second.status).toBe('applied');

    const campaigns = (await registry.call('mock_list_campaigns', { account_id: 'mock-1' }, ctx)) as {
      campaigns: Array<{ id: string; dailyBudgetMicros: number }>;
    };
    expect(campaigns.campaigns.find((c) => c.id === 'c1')?.dailyBudgetMicros).toBe(11_000_000);
  });
});
