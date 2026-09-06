import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createContext } from '../src/context.js';
import { SyntheticProvider, syntheticSeed, syntheticTools, type SyntheticStateStore } from '../src/testing/synthetic-provider.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'adport-synthetic-test-'));
  vi.stubEnv('ADPORT_HOME', home);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Synthetic provider must never access the network'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }); });

function fixture() {
  let state = syntheticSeed();
  const store: SyntheticStateStore = {
    async load() { return structuredClone(state); },
    async save(expected, next) {
      if (JSON.stringify(expected) !== JSON.stringify(state)) throw new Error('Concurrent state change');
      state = structuredClone(next);
    },
  };
  return { store, provider: new SyntheticProvider(store) };
}
const args = { account_id: 'demo-eur', campaign_id: 'demo-search', expected_daily_budget_micros: 25_000_000, daily_budget_micros: 27_000_000 };
const query = { level: 'campaign' as const, metrics: ['spend', 'conversions', 'roas'] as const, dateRange: 'last_7_days' as const };

it('uses the real policy gate, persists across runtimes, and never changes historical reports', async () => {
  const { store, provider } = fixture();
  const runtime = await createContext({ providerModules: [{ provider, tools: syntheticTools(provider) }] });
  const before = await provider.report({ ...query, metrics: [...query.metrics] });
  const preview = await runtime.registry.call('demo_set_budget', args, runtime.ctx) as { pending_operation_id: string; applied: boolean };
  expect(preview.applied).toBe(false);
  expect(preview).toMatchObject({ preview: { budgetDeltas: [
    { target: 'Daily budget', currency: 'EUR', fromMicros: 25_000_000, toMicros: 27_000_000 },
  ] } });
  expect((await provider.listCampaigns('demo-eur'))[0]?.dailyBudgetMicros).toBe(25_000_000);
  await expect(runtime.registry.call('demo_set_budget', { ...args, daily_budget_micros: 28_000_000, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
  const result = await runtime.registry.call('demo_set_budget', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);
  expect(result).toMatchObject({ applied: true });
  const reloaded = new SyntheticProvider(store);
  expect((await reloaded.listCampaigns('demo-eur'))[0]).toMatchObject({ dailyBudgetMicros: 27_000_000, status: 'PAUSED' });
  expect(await reloaded.report({ ...query, metrics: [...query.metrics] })).toEqual(before);
  await expect(runtime.registry.call('demo_set_budget', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects foreign accounts, cross-account campaigns, activation, stale budgets and excessive deltas', async () => {
  const { provider } = fixture();
  const runtime = await createContext({ providerModules: [{ provider, tools: syntheticTools(provider) }] });
  await expect(provider.listCampaigns('real-account')).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
  await expect(runtime.registry.call('demo_set_budget', { ...args, account_id: 'demo-usd' }, runtime.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(runtime.registry.call('demo_set_campaign_status', { status: 'ENABLED' }, runtime.ctx)).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
  await expect(runtime.registry.call('demo_set_budget', { ...args, expected_daily_budget_micros: 1 }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
  await expect(runtime.registry.call('demo_set_budget', { ...args, daily_budget_micros: 100_000_000 }, runtime.ctx)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
  expect(fetch).not.toHaveBeenCalled();
});

it('honors currency, account grouping, metric selection, range and limits', async () => {
  const { provider } = fixture();
  const campaigns = await provider.report({ ...query, metrics: ['spend'], accountIds: ['demo-eur'] });
  expect(campaigns.rows).toHaveLength(3);
  const account = await provider.report({ ...query, metrics: ['spend'], level: 'account', accountIds: ['demo-eur'] });
  expect(account.rows[0]).toMatchObject({ currency: 'EUR', entity: { level: 'account', id: 'demo-eur' }, metrics: { spend: campaigns.rows.reduce((sum, row) => sum + row.metrics.spend!, 0) } });
  expect(Object.keys(account.rows[0]!.metrics)).toEqual(['spend']);
  const usd = await provider.report({ ...query, metrics: ['spend'], accountIds: ['demo-usd'], dateRange: 'yesterday' });
  expect(usd.rows[0]).toMatchObject({ currency: 'USD', metrics: { spend: 22 } });
  expect((await provider.report({ ...query, metrics: ['spend'], limit: 1 })).truncated).toBe(true);
  await expect(provider.report({ ...query, metrics: ['spend'], level: 'ad' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
