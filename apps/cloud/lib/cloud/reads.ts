import 'server-only';
import type { Account, ReportRow } from '@adport/core';
import { createTenantRuntime } from './runtime';
import { listConnections } from './repository';
import { describeProviderError } from './provider-errors';
import type { TenantPrincipal } from './types';

export type ReadResult<T> = { ok: true; data: T; connected: boolean } | { ok: false; error: string; connected: boolean };

async function hasConnectedProvider(organizationId: string): Promise<boolean> {
  return (await listConnections(organizationId)).some((connection) => connection.status === 'connected');
}

function message(error: unknown): string {
  console.error('Provider read failed:', error instanceof Error ? error.constructor.name : typeof error);
  return describeProviderError(error);
}

/** Server-side account inventory across connected providers, via the shared registry. */
export async function readAccounts(principal: TenantPrincipal): Promise<ReadResult<Account[]>> {
  const connected = await hasConnectedProvider(principal.organizationId);
  if (!connected) return { ok: true, data: [], connected };
  try {
    const runtime = await createTenantRuntime(principal);
    const result = await runtime.registry.call('accounts_list', {}, runtime.ctx) as { accounts: Account[] };
    return { ok: true, data: result.accounts, connected };
  } catch (error) {
    return { ok: false, error: message(error), connected };
  }
}

/** Server-side campaign report across connected providers, via the shared registry. */
export async function readReport(principal: TenantPrincipal, dateRange: 'last_7_days' | 'last_30_days'): Promise<ReadResult<{ rows: ReportRow[]; truncated: boolean }>> {
  const connected = await hasConnectedProvider(principal.organizationId);
  if (!connected) return { ok: true, data: { rows: [], truncated: false }, connected };
  try {
    const runtime = await createTenantRuntime(principal);
    const result = await runtime.registry.call('report', {
      level: 'campaign', metrics: ['spend', 'impressions', 'clicks', 'conversions', 'roas'], date_range: dateRange, limit: 250,
    }, runtime.ctx) as { rows: ReportRow[]; truncated: boolean };
    return { ok: true, data: result, connected };
  } catch (error) {
    return { ok: false, error: message(error), connected };
  }
}
