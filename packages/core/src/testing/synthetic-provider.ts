import { z } from 'zod';
import { AdportError } from '../errors.js';
import { rangeDayCount, resolveDateRange, type MetricName, type NormalizedQuery, type Report, type ReportRow } from '../model.js';
import type { Account, AdProvider, WriteOperation, WritePreview, WriteResult } from '../provider.js';
import { defineTool, type AnyToolDefinition } from '../tools/registry.js';
import { guardedWriteTool } from '../tools/write.js';

export const syntheticCampaignSchema = z.object({
  id: z.string(), accountId: z.enum(['demo-eur', 'demo-usd']), name: z.string(),
  status: z.literal('PAUSED'), dailyBudgetMicros: z.number().int().positive().max(1_000_000_000),
});
export type SyntheticCampaign = z.infer<typeof syntheticCampaignSchema>;
export const syntheticStateSchema = z.array(syntheticCampaignSchema).min(1).max(20);

export function syntheticSeed(): SyntheticCampaign[] {
  return [
    { id: 'demo-search', accountId: 'demo-eur', name: 'Synthetic · Search', status: 'PAUSED', dailyBudgetMicros: 25_000_000 },
    { id: 'demo-discovery', accountId: 'demo-eur', name: 'Synthetic · Discovery', status: 'PAUSED', dailyBudgetMicros: 15_000_000 },
    { id: 'demo-retargeting', accountId: 'demo-eur', name: 'Synthetic · Retargeting', status: 'PAUSED', dailyBudgetMicros: 10_000_000 },
    { id: 'demo-us-search', accountId: 'demo-usd', name: 'Synthetic · US Search', status: 'PAUSED', dailyBudgetMicros: 20_000_000 },
  ];
}

/** Storage must be scoped to one reviewer organization, with atomic compare-and-set. */
export interface SyntheticStateStore {
  load(): Promise<SyntheticCampaign[]>;
  save(expected: SyntheticCampaign[], next: SyntheticCampaign[]): Promise<void>;
}

const accounts: Account[] = [
  { provider: 'demo', id: 'demo-eur', name: 'Synthetic Europe', currency: 'EUR', status: 'PAUSED' },
  { provider: 'demo', id: 'demo-usd', name: 'Synthetic US', currency: 'USD', status: 'PAUSED' },
];

/** No transport, credentials, or real-provider fallback. Historical metrics are fixtures. */
export class SyntheticProvider implements AdProvider {
  readonly id = 'demo';
  constructor(private readonly store: SyntheticStateStore) {}
  capabilities() { return { serverDryRun: false }; }
  async listAccounts() { return accounts.map(account => ({ ...account })); }
  assertAccount(id: string) {
    if (!accounts.some(account => account.id === id)) throw new AdportError('POLICY_VIOLATION', 'Account is outside this synthetic reviewer workspace.');
  }
  async listCampaigns(accountId: string) {
    this.assertAccount(accountId);
    return syntheticStateSchema.parse(await this.store.load()).filter(c => c.accountId === accountId);
  }
  async report(query: NormalizedQuery): Promise<Report> {
    for (const id of query.accountIds ?? []) this.assertAccount(id);
    if (!['account', 'campaign'].includes(query.level)) throw new AdportError('INVALID_INPUT', 'Synthetic reports support account and campaign levels only.');
    const range = resolveDateRange(query.dateRange);
    const days = rangeDayCount(range);
    if (!Number.isFinite(days) || range.start > range.end || days > 366) throw new AdportError('INVALID_INPUT', 'Use a valid synthetic report range of at most 366 days.');
    const campaigns = syntheticStateSchema.parse(await this.store.load());
    const rows: ReportRow[] = [];
    for (const account of accounts.filter(a => !query.accountIds || query.accountIds.includes(a.id))) {
      const selected = campaigns.filter(c => c.accountId === account.id);
      const groups = query.level === 'account' ? [selected] : selected.map(c => [c]);
      for (const group of groups) {
        if (!group.length) continue;
        const totals = { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversion_value: 0 };
        for (const c of group) {
          // Stable historical fixture: changing a current budget never rewrites past performance.
          const seed = syntheticSeed().findIndex(seed => seed.id === c.id) + 1;
          totals.spend += (10 + seed * 3) * days;
          totals.impressions += (1500 + seed * 850) * days;
          totals.clicks += (45 + seed * 17) * days;
          const conversions = c.id === 'demo-discovery' ? 0 : (2 + seed) * days;
          totals.conversions += conversions;
          totals.conversion_value += conversions * 24;
        }
        const metrics: Record<MetricName, number> = { ...totals,
          ctr: totals.clicks / totals.impressions * 100, cpc: totals.spend / totals.clicks,
          cpm: totals.spend / totals.impressions * 1000,
          cpa: totals.conversions ? totals.spend / totals.conversions : 0, roas: totals.conversion_value / totals.spend,
        };
        const entity = query.level === 'account' ? account : group[0]!;
        rows.push({ provider: this.id, accountId: account.id, currency: account.currency,
          entity: { level: query.level, id: entity.id, name: entity.name, status: 'PAUSED' },
          metrics: Object.fromEntries(query.metrics.map(metric => [metric, Math.round(metrics[metric] * 100) / 100])),
        });
      }
    }
    return { rows: rows.slice(0, query.limit ?? 100), truncated: rows.length > (query.limit ?? 100) };
  }
  private async plan(op: WriteOperation) {
    this.assertAccount(op.accountId);
    if (op.provider !== this.id || op.tool !== 'demo_set_budget' || op.kind !== 'update') throw new AdportError('INVALID_INPUT', 'Unsupported synthetic operation.');
    const payload = budgetSchema.parse(op.payload);
    const state = syntheticStateSchema.parse(await this.store.load());
    const campaign = state.find(c => c.accountId === op.accountId && c.id === payload.campaign_id);
    if (!campaign) throw new AdportError('INVALID_INPUT', 'Synthetic campaign not found in this account.');
    if (campaign.dailyBudgetMicros !== payload.expected_daily_budget_micros) throw new AdportError('PENDING_MISMATCH', 'Synthetic budget changed. Read the current budget and request a new preview.');
    const currency = accounts.find(a => a.id === op.accountId)!.currency;
    const preview: WritePreview = {
      summary: `Synthetic demo: change daily budget for "${campaign.name}"`,
      changes: [`~ campaign ${campaign.id} daily budget ${campaign.dailyBudgetMicros / 1e6} ${currency} → ${payload.daily_budget_micros / 1e6} ${currency}`],
      coercions: [], budgetDeltas: [{ target: campaign.name, fromMicros: campaign.dailyBudgetMicros, toMicros: payload.daily_budget_micros }],
      serverValidated: false,
    };
    return { state, campaign, payload, preview };
  }
  async previewWrite(op: WriteOperation) { return (await this.plan(op)).preview; }
  async applyWrite(op: WriteOperation): Promise<WriteResult> {
    const { state, campaign, payload } = await this.plan(op);
    await this.store.save(state, state.map(c => c.id === campaign.id && c.accountId === campaign.accountId ? { ...c, dailyBudgetMicros: payload.daily_budget_micros } : c));
    return { applied: true, resourceIds: [campaign.id], details: { data_source: 'synthetic', status: 'PAUSED', daily_budget_micros: payload.daily_budget_micros, real_ad_spend: false } };
  }
}

const budgetSchema = z.object({
  campaign_id: z.string(),
  expected_daily_budget_micros: z.number().int().positive().max(1_000_000_000),
  daily_budget_micros: z.number().int().positive().max(1_000_000_000),
});

export function syntheticTools(provider: SyntheticProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'demo_list_campaigns', namespace: 'demo',
      description: 'List synthetic reviewer campaigns and current budgets. No live advertising data.',
      input: z.object({ account_id: z.string() }), annotations: { readOnly: true, openWorld: false },
      async handler(input) { return { data_source: 'synthetic', campaigns: await provider.listCampaigns(input.account_id) }; },
    }),
    { ...guardedWriteTool({ name: 'demo_set_budget', namespace: 'demo', provider: 'demo', kind: 'update',
      description: 'Change a synthetic campaign budget using the normal preview/apply gate. No real ads or spend. Read demo_list_campaigns for the expected current budget first.', payload: budgetSchema,
    }), annotations: { readOnly: false, destructive: true, openWorld: false } },
  ];
}
