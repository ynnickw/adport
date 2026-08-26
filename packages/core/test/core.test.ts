import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
