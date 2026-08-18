import 'server-only';

import {
  createContext,
  type Account,
  type AdportRuntime,
  type ProviderModule,
  type ReportRow,
} from '@adport/core';
import { createAppleModule } from '@adport/provider-apple';
import { createGoogleModule } from '@adport/provider-google';
import { createMetaModule } from '@adport/provider-meta';
import { createMicrosoftModule } from '@adport/provider-microsoft';
import { createRedditModule } from '@adport/provider-reddit';
import { createTikTokModule } from '@adport/provider-tiktok';
import { getCloudStore } from './store';

const factories = [
  createGoogleModule,
  createMetaModule,
  createTikTokModule,
  createAppleModule,
  createMicrosoftModule,
  createRedditModule,
] as const;

export interface WorkspaceRuntime {
  runtime: AdportRuntime;
  allowedAccounts: Account[];
}

export async function createWorkspaceRuntime(workspaceId: string): Promise<WorkspaceRuntime> {
  const cloud = getCloudStore();
  const credentials = cloud.credentials(workspaceId);
  const modules: ProviderModule[] = [];
  for (const factory of factories) {
    const module = await factory(credentials);
    if (module) modules.push(module);
  }
  const connections = cloud.listConnections(workspaceId);
  const includeMock = connections.some((connection) => connection.provider === 'mock');
  const runtime = await createContext({
    providerModules: modules,
    includeMock,
    credentials,
    policy: cloud.policy(workspaceId),
    pending: cloud.pending(workspaceId),
    audit: cloud.audit(workspaceId),
    findings: cloud.findings(workspaceId),
  });
  return { runtime, allowedAccounts: cloud.listAccounts(workspaceId) };
}

export async function discoverAndAllowAccounts(workspaceId: string, provider?: string): Promise<Account[]> {
  const cloud = getCloudStore();
  const { runtime } = await createWorkspaceRuntime(workspaceId);
  const result = await runtime.registry.call('accounts_list', provider ? { provider } : {}, runtime.ctx) as { accounts: Account[] };
  cloud.saveAccounts(workspaceId, result.accounts);
  return result.accounts;
}

export async function listCloudAccounts(workspaceId: string): Promise<Account[]> {
  return getCloudStore().listAccounts(workspaceId);
}

export async function normalizedReport(workspaceId: string, dateRange: 'last_7_days' | 'last_30_days' = 'last_7_days'): Promise<ReportRow[]> {
  const { runtime, allowedAccounts } = await createWorkspaceRuntime(workspaceId);
  if (allowedAccounts.length === 0) return [];
  const rows: ReportRow[] = [];
  for (const provider of new Set(allowedAccounts.map((account) => account.provider))) {
    const accountIds = allowedAccounts.filter((account) => account.provider === provider).map((account) => account.id);
    const result = await runtime.registry.call('report', {
      provider,
      account_ids: accountIds,
      level: 'campaign',
      metrics: ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value', 'ctr', 'cpc', 'cpa', 'roas'],
      date_range: dateRange,
      limit: 500,
    }, runtime.ctx) as { rows: ReportRow[] };
    rows.push(...result.rows);
  }
  return rows;
}

export async function runWorkspaceAudit(workspaceId: string): Promise<void> {
  const { runtime, allowedAccounts } = await createWorkspaceRuntime(workspaceId);
  for (const provider of new Set(allowedAccounts.map((account) => account.provider))) {
    const accountIds = allowedAccounts.filter((account) => account.provider === provider).map((account) => account.id);
    await runtime.registry.call('audit_run', { provider, account_ids: accountIds, date_range: 'last_30_days' }, runtime.ctx);
  }
}
