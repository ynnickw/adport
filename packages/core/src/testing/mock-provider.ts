import { z } from 'zod';
import { AdportError } from '../errors.js';
import {
  rangeDayCount,
  resolveDateRange,
  type MetricName,
  type NormalizedQuery,
  type Report,
  type ReportRow,
} from '../model.js';
import type {
  Account,
  AdProvider,
  ProviderCapabilities,
  WriteGuard,
  WriteOperation,
  WritePreview,
  WriteResult,
} from '../provider.js';
import { defineTool, type AnyToolDefinition } from '../tools/registry.js';
import { guardedWriteTool } from '../tools/write.js';

interface MockCampaign {
  id: string;
  name: string;
  status: 'ENABLED' | 'PAUSED' | 'REMOVED';
  dailyBudgetMicros: number;
}

interface MockAccount extends Account {
  campaigns: MockCampaign[];
}

function seedAccounts(): MockAccount[] {
  return [
    {
      provider: 'mock',
      id: 'mock-1',
      name: 'Acme DTC Store',
      currency: 'EUR',
      status: 'ENABLED',
      campaigns: [
        { id: 'c1', name: 'Brand Search', status: 'ENABLED', dailyBudgetMicros: 10_000_000 },
        { id: 'c2', name: 'Prospecting', status: 'ENABLED', dailyBudgetMicros: 25_000_000 },
      ],
    },
    {
      provider: 'mock',
      id: 'mock-2',
      name: 'Beta App',
      currency: 'USD',
      status: 'ENABLED',
      campaigns: [{ id: 'c3', name: 'Install Campaign', status: 'PAUSED', dailyBudgetMicros: 5_000_000 }],
    },
  ];
}

/**
 * In-memory provider for tests, demos, and trying adport without credentials.
 * Deterministic: same inputs always produce the same report numbers.
 */
export class MockProvider implements AdProvider {
  readonly id = 'mock';
  private accounts: MockAccount[] = seedAccounts();

  capabilities(): ProviderCapabilities {
    return { serverDryRun: false };
  }

  async listAccounts(): Promise<Account[]> {
    return this.accounts.map(({ campaigns: _campaigns, ...account }) => account);
  }

  listCampaigns(accountId: string): MockCampaign[] {
    return [...this.account(accountId).campaigns];
  }

  async report(query: NormalizedQuery): Promise<Report> {
    const range = resolveDateRange(query.dateRange);
    const days = rangeDayCount(range);
    const rows: ReportRow[] = [];
    for (const account of this.accounts) {
      if (query.accountIds && !query.accountIds.includes(account.id)) continue;
      for (const [index, campaign] of account.campaigns.entries()) {
        if (campaign.status === 'REMOVED') continue;
        rows.push({
          provider: this.id,
          accountId: account.id,
          entity: { level: 'campaign', id: campaign.id, name: campaign.name, status: campaign.status },
          metrics: mockMetrics(query.metrics, index, days, campaign.dailyBudgetMicros),
        });
      }
    }
    return { rows };
  }

  async previewWrite(op: WriteOperation, guard: WriteGuard): Promise<WritePreview> {
    return this.plan(op, guard).preview;
  }

  async applyWrite(op: WriteOperation, guard: WriteGuard): Promise<WriteResult> {
    return this.plan(op, guard).apply();
  }

  private account(accountId: string): MockAccount {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) throw new AdportError('PROVIDER_ERROR', `mock: unknown account ${accountId}`);
    return account;
  }

  private campaign(accountId: string, campaignId: string): MockCampaign {
    const campaign = this.account(accountId).campaigns.find((c) => c.id === campaignId);
    if (!campaign) throw new AdportError('PROVIDER_ERROR', `mock: unknown campaign ${campaignId}`);
    return campaign;
  }

  /** Compute preview and applier together so dry-run and apply can never drift. */
  private plan(op: WriteOperation, guard: WriteGuard): { preview: WritePreview; apply: () => WriteResult } {
    const base = { coercions: [] as string[], budgetDeltas: [], serverValidated: false };
    switch (op.tool) {
      case 'mock_create_campaign': {
        const payload = op.payload as { name: string; daily_budget_micros: number; status?: string };
        let status = (payload.status ?? 'ENABLED') as MockCampaign['status'];
        const coercions: string[] = [];
        if (guard.forcePausedCreation && status === 'ENABLED') {
          status = 'PAUSED';
          coercions.push('status coerced to PAUSED by policy (paused_creation)');
        }
        const account = this.account(op.accountId);
        const id = `c${100 + account.campaigns.length}`;
        return {
          preview: {
            ...base,
            summary: `Create campaign "${payload.name}" (${status}) with daily budget ${payload.daily_budget_micros} micros`,
            changes: [`+ campaign ${id} "${payload.name}" status=${status}`],
            coercions,
            budgetDeltas: [{ target: `new campaign "${payload.name}" daily budget`, toMicros: payload.daily_budget_micros }],
          },
          apply: () => {
            account.campaigns.push({ id, name: payload.name, status, dailyBudgetMicros: payload.daily_budget_micros });
            return { applied: true, resourceIds: [id] };
          },
        };
      }
      case 'mock_set_budget': {
        const payload = op.payload as { campaign_id: string; daily_budget_micros: number };
        const campaign = this.campaign(op.accountId, payload.campaign_id);
        return {
          preview: {
            ...base,
            summary: `Change "${campaign.name}" daily budget ${campaign.dailyBudgetMicros} → ${payload.daily_budget_micros} micros`,
            changes: [`~ campaign ${campaign.id} daily_budget ${campaign.dailyBudgetMicros} → ${payload.daily_budget_micros}`],
            budgetDeltas: [
              {
                target: `campaign "${campaign.name}" daily budget`,
                fromMicros: campaign.dailyBudgetMicros,
                toMicros: payload.daily_budget_micros,
              },
            ],
          },
          apply: () => {
            campaign.dailyBudgetMicros = payload.daily_budget_micros;
            return { applied: true, resourceIds: [campaign.id] };
          },
        };
      }
      case 'mock_set_campaign_status': {
        const payload = op.payload as { campaign_id: string; status: 'ENABLED' | 'PAUSED' };
        const campaign = this.campaign(op.accountId, payload.campaign_id);
        return {
          preview: {
            ...base,
            summary: `Set "${campaign.name}" status ${campaign.status} → ${payload.status}`,
            changes: [`~ campaign ${campaign.id} status ${campaign.status} → ${payload.status}`],
          },
          apply: () => {
            campaign.status = payload.status;
            return { applied: true, resourceIds: [campaign.id] };
          },
        };
      }
      case 'mock_remove_campaign': {
        const payload = op.payload as { campaign_id: string };
        const campaign = this.campaign(op.accountId, payload.campaign_id);
        return {
          preview: {
            ...base,
            summary: `PERMANENTLY remove campaign "${campaign.name}"`,
            changes: [`- campaign ${campaign.id} "${campaign.name}"`],
          },
          apply: () => {
            campaign.status = 'REMOVED';
            return { applied: true, resourceIds: [campaign.id] };
          },
        };
      }
      default:
        throw new AdportError('PROVIDER_ERROR', `mock: unsupported write tool ${op.tool}`);
    }
  }
}

function mockMetrics(
  requested: MetricName[],
  seed: number,
  days: number,
  dailyBudgetMicros: number,
): Partial<Record<MetricName, number>> {
  const spend = ((dailyBudgetMicros / 1_000_000) * 0.83 + seed) * days;
  const impressions = (2_000 + seed * 700) * days;
  const clicks = (90 + seed * 35) * days;
  const conversions = (4 + seed) * days;
  const conversionValue = conversions * (35 + seed * 5);
  const all: Record<MetricName, number> = {
    spend: round2(spend),
    impressions,
    clicks,
    conversions,
    conversion_value: round2(conversionValue),
    ctr: round2((clicks / impressions) * 100),
    cpc: round2(spend / clicks),
    cpm: round2((spend / impressions) * 1000),
    cpa: round2(spend / conversions),
    roas: round2(conversionValue / spend),
  };
  return Object.fromEntries(requested.map((m) => [m, all[m]]));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function mockTools(): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'mock_list_campaigns',
      namespace: 'mock',
      description: 'List campaigns in a mock account (id, name, status, daily budget).',
      input: z.object({ account_id: z.string() }),
      annotations: { readOnly: true },
      async handler(input, ctx) {
        const provider = ctx.providers.get('mock') as MockProvider;
        return { campaigns: provider.listCampaigns(input.account_id) };
      },
    }),
    guardedWriteTool({
      name: 'mock_create_campaign',
      namespace: 'mock',
      description: 'Create a campaign in the mock account.',
      provider: 'mock',
      kind: 'create',
      payload: z.object({
        name: z.string().min(1),
        daily_budget_micros: z.number().int().positive(),
        status: z.enum(['ENABLED', 'PAUSED']).optional(),
      }),
    }),
    guardedWriteTool({
      name: 'mock_set_budget',
      namespace: 'mock',
      description: 'Change a mock campaign daily budget.',
      provider: 'mock',
      kind: 'update',
      payload: z.object({ campaign_id: z.string(), daily_budget_micros: z.number().int().positive() }),
    }),
    guardedWriteTool({
      name: 'mock_set_campaign_status',
      namespace: 'mock',
      description: 'Enable or pause a mock campaign.',
      provider: 'mock',
      kind: 'update',
      payload: z.object({ campaign_id: z.string(), status: z.enum(['ENABLED', 'PAUSED']) }),
    }),
    guardedWriteTool({
      name: 'mock_remove_campaign',
      namespace: 'mock',
      description: 'Permanently remove a mock campaign.',
      provider: 'mock',
      kind: 'remove',
      destructive: true,
      payload: z.object({ campaign_id: z.string() }),
    }),
  ];
}
