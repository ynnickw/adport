import 'server-only';
import type { Account, ReportRow } from '@adport/core';
import { createTenantRuntime } from './runtime';
import { listConnections } from './repository';
import { describeProviderError } from './provider-errors';
import type { TenantPrincipal } from './types';

export interface ProviderReadWarning { provider: string; message: string }
export type ReadResult<T> =
  | { ok: true; data: T; connected: boolean; warnings: ProviderReadWarning[] }
  | { ok: false; error: string; connected: boolean; warnings: ProviderReadWarning[] };

async function hasConnectedProvider(organizationId: string): Promise<boolean> {
  return (await listConnections(organizationId)).some((connection) => connection.status === 'connected');
}

function message(error: unknown, provider?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  console.error('Provider read failed', {
    provider: provider ?? 'unknown',
    code: error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined,
    message: raw.replace(/(bearer|token|secret|authorization)[=: ]+[^\s,;]+/gi, '$1=<redacted>').slice(0, 500),
  });
  return describeProviderError(error, provider);
}

function warnings(errors: Array<{ provider: string; message: string }>): ProviderReadWarning[] {
  return errors.map((error) => ({ provider: error.provider, message: describeProviderError(new Error(error.message), error.provider) }));
}

/** Server-side account inventory across connected providers, via the shared registry. */
export async function readAccounts(principal: TenantPrincipal): Promise<ReadResult<Account[]>> {
  const connected = await hasConnectedProvider(principal.organizationId);
  if (!connected) return { ok: true, data: [], connected, warnings: [] };
  try {
    const runtime = await createTenantRuntime(principal);
    const result = await runtime.registry.call('accounts_list', { continue_on_error: true }, runtime.ctx) as {
      accounts: Account[]; errors: Array<{ provider: string; message: string }>;
    };
    result.errors.forEach((error) => message(new Error(error.message), error.provider));
    return { ok: true, data: result.accounts, connected, warnings: warnings(result.errors) };
  } catch (error) {
    return { ok: false, error: message(error), connected, warnings: [] };
  }
}

/** Server-side campaign report across connected providers, via the shared registry. */
export async function readReport(principal: TenantPrincipal, dateRange: 'last_7_days' | 'last_30_days'): Promise<ReadResult<{ rows: ReportRow[]; truncated: boolean }>> {
  const connected = await hasConnectedProvider(principal.organizationId);
  if (!connected) return { ok: true, data: { rows: [], truncated: false }, connected, warnings: [] };
  try {
    const runtime = await createTenantRuntime(principal);
    const result = await runtime.registry.call('report', {
      level: 'campaign', metrics: ['spend', 'impressions', 'clicks', 'conversions', 'roas'], date_range: dateRange,
      limit: 250, continue_on_error: true,
    }, runtime.ctx) as { rows: ReportRow[]; truncated: boolean; errors: Array<{ provider: string; message: string }> };
    result.errors.forEach((error) => message(new Error(error.message), error.provider));
    return { ok: true, data: { rows: result.rows, truncated: result.truncated }, connected, warnings: warnings(result.errors) };
  } catch (error) {
    return { ok: false, error: message(error), connected, warnings: [] };
  }
}
