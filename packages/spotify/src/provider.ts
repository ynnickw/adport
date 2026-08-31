import { z } from 'zod';
import {
  AdportError, resolveDateRange, type Account, type AdProvider, type MetricName,
  type NormalizedQuery, type Report, type ReportRow, type StandardActions,
  type WriteGuard, type WriteOperation, type WritePreview, type WriteResult,
} from '@adport/core';
import { SpotifyAdsClient } from './client.js';
import {
  accountSchema, adSetSchema, businessSchema, campaignSchema, createDraftSchema,
  draftSchema, pagingSchema, reportSchema, setBudgetSchema, setDeliverySchema,
  setStatusSchema, spotifyId,
} from './schemas.js';

interface Plan extends Omit<WritePreview, 'serverValidated'> { execute: () => Promise<string[]> }
const LEVEL = { account: 'AD_ACCOUNT', campaign: 'CAMPAIGN', ad_group: 'AD_SET', ad: 'AD' } as const;
const FIELDS = { spend: 'SPEND', impressions: 'IMPRESSIONS', clicks: 'CLICKS', conversions: 'PURCHASES', conversion_value: 'REVENUE' } as const;
const DERIVED = {
  ctr: ['clicks', 'impressions', 100], cpc: ['spend', 'clicks', 1], cpm: ['spend', 'impressions', 1000],
  cpa: ['spend', 'conversions', 1], roas: ['conversion_value', 'spend', 1],
} as const;

export class SpotifyAdsProvider implements AdProvider {
  readonly id = 'spotify';
  constructor(private readonly client: SpotifyAdsClient) {}
  capabilities() { return { serverDryRun: false }; }
  standardActions(): StandardActions {
    return { pauseCampaign: (accountId, campaignId) => ({ tool: 'spotify_set_campaign_status', input: { account_id: accountId, campaign_id: campaignId, status: 'PAUSED' } }) };
  }

  async listAccounts(): Promise<Account[]> {
    const { businesses } = await this.client.get('businesses', z.object({ businesses: z.array(businessSchema) }));
    const accounts = new Map<string, Account>();
    for (const business of businesses) {
      const { ad_accounts } = await this.client.get(`businesses/${business.id}/ad_accounts`, z.object({ ad_accounts: z.array(accountSchema) }));
      for (const account of ad_accounts) accounts.set(account.id, { provider: this.id, id: account.id, name: account.name, currency: account.currency_code, status: account.status });
    }
    return [...accounts.values()];
  }

  async listCampaigns(accountId: string) {
    const path = `ad_accounts/${spotifyId.parse(accountId)}/campaigns`;
    const schema = z.object({ paging: pagingSchema, campaigns: z.array(campaignSchema) });
    const rows: z.infer<typeof campaignSchema>[] = [];
    const seen = new Set<string>();
    for (let page = 0, offset = 0; page < 1000; page++) {
      const data = await this.client.get(path, schema, new URLSearchParams({ limit: '50', offset: String(offset), sort_field: 'ID', sort_direction: 'ASC' }));
      if (data.paging.offset !== offset) throw new AdportError('PROVIDER_ERROR', 'spotify: campaign pagination changed offset');
      for (const campaign of data.campaigns) {
        if (seen.has(campaign.id)) throw new AdportError('PROVIDER_ERROR', 'spotify: campaign pagination repeated an entity');
        seen.add(campaign.id);
        rows.push(campaign);
      }
      offset += data.campaigns.length;
      if (offset >= data.paging.total_results) return rows;
      if (!data.campaigns.length) break;
    }
    throw new AdportError('PROVIDER_ERROR', 'spotify: campaign pagination did not terminate; refusing incomplete results');
  }

  async getAdSet(accountId: string, adSetId: string) {
    const data = await this.client.get(`ad_accounts/${spotifyId.parse(accountId)}/ad_sets/${spotifyId.parse(adSetId)}`, adSetSchema);
    if (data.id !== adSetId) throw new AdportError('PROVIDER_ERROR', 'spotify: ad set response ID mismatch');
    return data;
  }

  async report(query: NormalizedQuery): Promise<Report> {
    const range = resolveDateRange(query.dateRange);
    const start = z.iso.date().parse(range.start), end = z.iso.date().parse(range.end);
    const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    if (days < 0 || days > 90) throw new AdportError('INVALID_INPUT', 'spotify: report end must be on/after start and within 90 days');
    const limit = query.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AdportError('INVALID_INPUT', 'spotify: report limit must be a positive integer');
    const fields = new Set<string>();
    for (const metric of query.metrics) {
      if (metric in FIELDS) fields.add(FIELDS[metric as keyof typeof FIELDS]);
      else if (metric in DERIVED) for (const dependency of DERIVED[metric as keyof typeof DERIVED].slice(0, 2)) fields.add(FIELDS[dependency as keyof typeof FIELDS]);
    }
    if (!fields.size) throw new AdportError('INVALID_INPUT', 'spotify: report requires at least one supported metric');
    const accountIds = [...new Set(query.accountIds ?? (await this.listAccounts()).map(a => a.id))];
    const rows: ReportRow[] = [];
    for (const id of accountIds) {
      const accountId = spotifyId.parse(id);
      let params = new URLSearchParams({ entity_type: LEVEL[query.level], report_start: `${start}T00:00:00Z`, report_end: `${end}T00:00:00Z`, granularity: 'LIFETIME', limit: '50' });
      for (const field of fields) params.append('fields', field);
      const tokens = new Set<string>();
      const entities = new Set<string>();
      while (true) {
        const data = await this.client.get(`ad_accounts/${accountId}/aggregate_reports`, reportSchema, params);
        if (data.granularity !== 'LIFETIME') throw new AdportError('PROVIDER_ERROR', 'spotify: unexpected report granularity');
        for (const row of data.rows) {
          if (row.entity_type !== LEVEL[query.level] || (query.level === 'account' && row.entity_id !== accountId) || entities.has(row.entity_id)) {
            throw new AdportError('PROVIDER_ERROR', 'spotify: incorrectly scoped or duplicate report row');
          }
          entities.add(row.entity_id);
          rows.push({ provider: this.id, accountId, entity: { level: query.level, id: row.entity_id, name: row.entity_name, status: row.entity_status }, metrics: normalize(row.stats, query.metrics) });
          if (rows.length > limit) return { rows: rows.slice(0, limit), truncated: true };
        }
        if (!data.continuation_token) break;
        if (tokens.has(data.continuation_token) || tokens.size >= 1000) throw new AdportError('PROVIDER_ERROR', 'spotify: report pagination did not terminate');
        tokens.add(data.continuation_token);
        // Other parameters are ignored by Spotify when a continuation is supplied.
        params = new URLSearchParams({ continuation_token: data.continuation_token });
      }
    }
    return { rows };
  }

  async previewWrite(op: WriteOperation, guard: WriteGuard): Promise<WritePreview> {
    const { execute: _execute, ...preview } = await this.plan(op, guard);
    return { ...preview, serverValidated: false };
  }
  async applyWrite(op: WriteOperation, guard: WriteGuard): Promise<WriteResult> {
    return { applied: true, resourceIds: await (await this.plan(op, guard)).execute() };
  }

  private async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const accountId = spotifyId.parse(op.accountId);
    const base = `ad_accounts/${accountId}`;
    if (op.provider !== this.id) throw new AdportError('INVALID_INPUT', 'spotify: provider mismatch');
    if (op.tool === 'spotify_create_campaign_draft' && op.kind === 'create') {
      const input = createDraftSchema.parse(op.payload);
      const status = guard.forcePausedCreation ? 'PAUSED' : input.status;
      const body = { ...input, status };
      return {
        summary: `Create Spotify campaign draft "${input.name}" (not published)`, changes: [`+ ${JSON.stringify(body)}`],
        coercions: input.status !== status ? ['status coerced to PAUSED by policy (paused_creation)'] : [], budgetDeltas: [],
        execute: async () => {
          const result = await this.client.mutate(`${base}/drafts/campaigns`, 'POST', body, draftSchema);
          if (result.ad_account_id !== accountId || result.status !== status) throw new AdportError('PROVIDER_ERROR', 'spotify: created draft response violated account/status expectations; inspect the draft before retrying');
          return [result.id];
        },
      };
    }
    if (op.tool === 'spotify_set_campaign_status' && op.kind === 'update') {
      const input = setStatusSchema.parse(op.payload);
      const path = `${base}/campaigns/${input.campaign_id}`;
      const current = await this.client.get(path, campaignSchema);
      if (current.id !== input.campaign_id) throw new AdportError('PROVIDER_ERROR', 'spotify: campaign response ID mismatch');
      return {
        summary: `Change Spotify campaign "${current.name}" status`, changes: [`~ ${current.id} status: ${current.status} → ${input.status}`], coercions: [], budgetDeltas: [],
        execute: async () => {
          const result = await this.client.mutate(path, 'PATCH', { status: input.status }, campaignSchema);
          if (result.id !== current.id || result.status !== input.status) throw new AdportError('PROVIDER_ERROR', 'spotify: campaign update response mismatch; inspect before retrying');
          return [result.id];
        },
      };
    }
    if (op.kind === 'update' && ['spotify_set_budget', 'spotify_set_ad_set_delivery'].includes(op.tool)) {
      const input = op.tool === 'spotify_set_budget' ? setBudgetSchema.parse(op.payload) : setDeliverySchema.parse(op.payload);
      const current = await this.getAdSet(accountId, input.ad_set_id);
      const budget = 'budget_micros' in input ? { micro_amount: input.budget_micros, type: current.budget.type } : undefined;
      // Delivery must be the sole field in an ad-set PATCH. Budget changes keep
      // the existing budget type so DAILY/LIFETIME deltas stay comparable.
      const body = budget ? { budget } : { delivery: 'delivery' in input ? input.delivery : current.delivery };
      return {
        summary: `Change Spotify ad set "${current.name}" ${budget ? 'budget' : 'delivery'}`,
        changes: [budget ? `~ ${current.id} ${budget.type} budget micros: ${current.budget.micro_amount} → ${budget.micro_amount}` : `~ ${current.id} delivery: ${current.delivery} → ${body.delivery}`],
        coercions: [], budgetDeltas: budget ? [{ target: `ad set ${current.id} ${budget.type} budget`, fromMicros: current.budget.micro_amount, toMicros: budget.micro_amount }] : [],
        execute: async () => {
          const result = await this.client.mutate(`${base}/ad_sets/${current.id}`, 'PATCH', body, adSetSchema);
          if (result.id !== current.id || result.campaign_id !== current.campaign_id
            || (budget && (result.budget.type !== budget.type || result.budget.micro_amount !== budget.micro_amount))
            || (!budget && result.delivery !== body.delivery)) {
            throw new AdportError('PROVIDER_ERROR', 'spotify: ad set update response mismatch; inspect before retrying');
          }
          return [result.id];
        },
      };
    }
    throw new AdportError('INVALID_INPUT', `spotify: unsupported write ${op.tool}`);
  }
}

function normalize(stats: Array<{ field_type: string; field_value: number }>, requested: MetricName[]) {
  const raw = new Map<string, number>();
  for (const stat of stats) {
    if (raw.has(stat.field_type)) throw new AdportError('PROVIDER_ERROR', 'spotify: duplicate report metric');
    raw.set(stat.field_type, stat.field_value);
  }
  const mapped: Partial<Record<MetricName, number>> = {};
  for (const [metric, field] of Object.entries(FIELDS)) {
    const value = raw.get(field);
    // Suppressed conversion counts (-5) and missing metrics are not zero.
    if (value !== undefined && value >= 0) mapped[metric as MetricName] = value;
  }
  for (const [metric, [numerator, denominator, factor]] of Object.entries(DERIVED)) {
    if (mapped[numerator] !== undefined && mapped[denominator] !== undefined) mapped[metric as MetricName] = mapped[denominator] ? mapped[numerator]! / mapped[denominator]! * factor : 0;
  }
  return Object.fromEntries(requested.filter(metric => mapped[metric] !== undefined).map(metric => [metric, mapped[metric]]));
}
