import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../src/context.js';
import { reportPeriods } from '../src/report-dates.js';
import type { AdProvider } from '../src/provider.js';
import type { NormalizedQuery } from '../src/model.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'adport-daily-report-')); process.env.ADPORT_HOME = home; });
afterEach(() => { delete process.env.ADPORT_HOME; rmSync(home, { recursive: true, force: true }); });

function provider(report: AdProvider['report']): AdProvider {
  return { id: 'test', capabilities: () => ({ serverDryRun: false }),
    listAccounts: async () => [{ id: 'one', provider: 'test', name: 'Example', currency: 'USD' }], report,
    previewWrite: async () => { throw new Error('No write'); }, applyWrite: async () => { throw new Error('No write'); } };
}

describe('dated report observations', () => {
  it('reads each exact date, preserves account scope and summarizes only returned observations', async () => {
    const reads = vi.fn(async (query: NormalizedQuery) => ({ rows: [{ provider: 'test', accountId: 'one', currency: 'USD', entity: { level: 'campaign' as const, id: 'campaign', name: 'Example' }, metrics: { spend: typeof query.dateRange === 'object' && query.dateRange.start === '2026-11-01' ? 10 : 20 } }] }));
    const runtime = await createContext({ providerModules: [{ provider: provider(reads), tools: [] }] });
    const result = await runtime.registry.call('report', { provider: 'test', account_ids: ['one'], date_range: { start: '2026-11-01', end: '2026-11-02' }, granularity: 'day', metrics: ['spend'] }, runtime.ctx) as any;
    expect(reads.mock.calls.map(([query]) => ({ dates: query.dateRange, ids: query.accountIds }))).toEqual([
      { dates: { start: '2026-11-01', end: '2026-11-01' }, ids: ['one'] }, { dates: { start: '2026-11-02', end: '2026-11-02' }, ids: ['one'] },
    ]);
    expect(result.rows.map((row: any) => [row.date, row.metrics.spend])).toEqual([['2026-11-01', 10], ['2026-11-02', 20]]);
    expect(result.summary.groups[0].metrics.spend).toBe(30);
    expect(result.resolved_date_range).toEqual({ start: '2026-11-01', end: '2026-11-02' });
  });
  it('preserves missing days and partial-date failures instead of inventing zero rows', async () => {
    const reads = vi.fn(async (query: NormalizedQuery) => {
      const date = typeof query.dateRange === 'object' ? query.dateRange.start : '';
      if (date === '2026-11-02') throw new Error('Provider unavailable');
      return { rows: date === '2026-11-01' ? [{ provider: 'test', accountId: 'one', currency: 'USD', entity: { level: 'campaign' as const, id: 'campaign', name: 'Example' }, metrics: { spend: 0 } }] : [] };
    });
    const runtime = await createContext({ providerModules: [{ provider: provider(reads), tools: [] }] });
    const result = await runtime.registry.call('report', { granularity: 'day', date_range: { start: '2026-11-01', end: '2026-11-03' }, continue_on_error: true }, runtime.ctx) as any;
    expect(result.rows).toHaveLength(1); expect(result.rows[0]).toMatchObject({ date: '2026-11-01', metrics: { spend: 0 } });
    expect(result.errors).toEqual([{ provider: 'test', date: '2026-11-02', message: 'Provider unavailable' }]);
    expect(result.summary.complete).toBe(false);
  });
  it('bounds daily fan-out and rejects impossible dates before any provider read', async () => {
    const reads = vi.fn(async (_query: NormalizedQuery) => ({ rows: [] }));
    const runtime = await createContext({ providerModules: [{ provider: provider(reads), tools: [] }] });
    for (const date_range of [{ start: '2026-01-01', end: '2026-02-01' }, { start: '2026-02-30', end: '2026-03-01' }, { start: '2026-11-03', end: '2026-11-01' }]) {
      await expect(runtime.registry.call('report', { date_range, granularity: 'day' }, runtime.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(reads).not.toHaveBeenCalled();
    expect(reportPeriods({ start: '2024-02-28', end: '2024-03-01' }, 'day')).toHaveLength(3);
  });
  it('keeps the ordinary aggregate report to one unchanged query per provider', async () => {
    const reads = vi.fn(async (_query: NormalizedQuery) => ({ rows: [] }));
    const runtime = await createContext({ providerModules: [{ provider: provider(reads), tools: [] }] });
    await runtime.registry.call('report', {}, runtime.ctx);
    expect(reads).toHaveBeenCalledOnce(); expect(reads.mock.calls[0]?.[0]).toMatchObject({ dateRange: 'last_7_days' });
  });
});
