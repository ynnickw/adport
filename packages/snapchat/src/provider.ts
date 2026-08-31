import {
  AdportError, resolveDateRange, type Account, type AdProvider, type MetricName,
  type NormalizedQuery, type Report, type ReportRow, type StandardActions,
  type WriteGuard, type WriteOperation, type WritePreview, type WriteResult,
} from '@adport/core';
import { SnapchatAdsClient } from './client.js';
import {
  accountSchema, campaignSchema, createCampaignSchema, organizationSchema,
  setBudgetSchema, setStatusSchema, snapchatId, statSchema,
} from './schemas.js';

interface Plan extends Omit<WritePreview, 'serverValidated'> { execute: () => Promise<string[]> }
const MICROS = 1_000_000;
const FIELDS = 'spend,impressions,swipes,conversion_purchases,conversion_purchases_value';
const BREAKDOWN = { account: 'campaign', campaign: 'campaign', ad_group: 'adsquad', ad: 'ad' } as const;

export class SnapchatAdsProvider implements AdProvider {
  readonly id = 'snapchat';
  constructor(private readonly client: SnapchatAdsClient) {}
  capabilities() { return { serverDryRun: false }; }
  standardActions(): StandardActions {
    return { pauseCampaign: (accountId, campaignId) => ({
      tool: 'snapchat_set_campaign_status', input: { account_id: accountId, campaign_id: campaignId, status: 'PAUSED' },
    }) };
  }

  async listAccounts(): Promise<Account[]> {
    const organizations = await this.client.collection('me/organizations', 'organizations', 'organization', organizationSchema);
    const accounts = new Map<string, Account>();
    for (const organization of organizations) {
      const rows = await this.client.collection(`organizations/${organization.id}/adaccounts`, 'adaccounts', 'adaccount', accountSchema);
      for (const account of rows) accounts.set(account.id, {
        provider: this.id, id: account.id, name: account.name, currency: account.currency, status: account.status,
      });
    }
    return [...accounts.values()];
  }

  async listCampaigns(accountId: string) {
    return this.client.collection(`adaccounts/${snapchatId.parse(accountId)}/campaigns`, 'campaigns', 'campaign', campaignSchema, { limit: '1000' });
  }

  async report(query: NormalizedQuery): Promise<Report> {
    const range = resolveDateRange(query.dateRange);
    const accountIds = query.accountIds ?? (await this.listAccounts()).map(a => a.id);
    const rows: ReportRow[] = [];
    const limit = query.limit ?? 1000;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AdportError('INVALID_INPUT', 'snapchat: report limit must be a positive integer');
    for (const id of accountIds) {
      const accountId = snapchatId.parse(id);
      const accounts = await this.client.collection(`adaccounts/${accountId}`, 'adaccounts', 'adaccount', accountSchema);
      const account = accounts.find(a => a.id === accountId);
      if (!account) throw new AdportError('PROVIDER_ERROR', 'snapchat: requested account missing from response');
      const breakdown = BREAKDOWN[query.level];
      // Account-level /stats only supports spend. Aggregate the campaign
      // breakdown for complete account metrics; never sum already-derived ratios.
      const totals = await this.client.collection(`adaccounts/${accountId}/stats`, 'total_stats', 'total_stat', statSchema, {
        granularity: 'TOTAL', breakdown, fields: FIELDS,
        start_time: accountMidnight(range.start, account.timezone),
        end_time: accountMidnight(nextDate(range.end), account.timezone),
        swipe_up_attribution_window: '28_DAY', view_attribution_window: '1_DAY',
      });
      const stats = totals.flatMap(total => {
        if (total.id !== accountId || !total.breakdown_stats || !Array.isArray(total.breakdown_stats[breakdown])) {
          throw new AdportError('PROVIDER_ERROR', 'snapchat: malformed or incorrectly scoped report breakdown');
        }
        return total.breakdown_stats[breakdown]!;
      });
      if (query.level === 'account') {
        const sums: Record<string, number> = {};
        for (const field of FIELDS.split(',')) {
          if (stats.every(row => row.stats[field] !== undefined)) sums[field] = stats.reduce((sum, row) => sum + row.stats[field]!, 0);
        }
        rows.push({ provider: this.id, accountId, entity: { level: 'account', id: accountId, name: account.name, status: account.status }, metrics: normalize(sums, query.metrics) });
      } else {
        for (const stat of stats) rows.push({
          provider: this.id, accountId, entity: { level: query.level, id: stat.id, name: stat.id }, metrics: normalize(stat.stats, query.metrics),
        });
      }
    }
    return { rows: rows.slice(0, limit), ...(rows.length > limit ? { truncated: true } : {}) };
  }

  async previewWrite(op: WriteOperation, guard: WriteGuard): Promise<WritePreview> {
    const { execute: _execute, ...preview } = await this.plan(op, guard);
    return { ...preview, serverValidated: false };
  }
  async applyWrite(op: WriteOperation, guard: WriteGuard): Promise<WriteResult> {
    return { applied: true, resourceIds: await (await this.plan(op, guard)).execute() };
  }

  private async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const accountId = snapchatId.parse(op.accountId);
    if (op.provider !== this.id) throw new AdportError('INVALID_INPUT', 'snapchat: provider mismatch');
    if (op.tool === 'snapchat_create_campaign' && op.kind === 'create') {
      const input = createCampaignSchema.parse(op.payload);
      if (input.end_time && Date.parse(input.end_time) <= Date.parse(input.start_time)) {
        throw new AdportError('INVALID_INPUT', 'snapchat: end_time must be after start_time');
      }
      const status = guard.forcePausedCreation ? 'PAUSED' : input.status;
      const body = { campaigns: [{ ...input, ad_account_id: accountId, status, buy_model: 'AUCTION' }] };
      return {
        summary: `Create Snapchat campaign "${input.name}"`,
        changes: [`+ ${JSON.stringify(body)}`],
        coercions: status !== input.status ? ['status coerced to PAUSED by policy (paused_creation)'] : [],
        budgetDeltas: ['daily_budget_micro', 'lifetime_spend_cap_micro'].flatMap(field => {
          const value = input[field as 'daily_budget_micro' | 'lifetime_spend_cap_micro'];
          return value === undefined ? [] : [{ target: `new campaign ${field}`, toMicros: value }];
        }),
        execute: async () => (await this.client.mutate(`adaccounts/${accountId}/campaigns`, 'POST', body, 'campaigns', 'campaign', campaignSchema)).map(c => c.id),
      };
    }
    if (op.kind !== 'update' || !['snapchat_set_campaign_status', 'snapchat_set_budget'].includes(op.tool)) {
      throw new AdportError('INVALID_INPUT', `snapchat: unsupported write ${op.tool}`);
    }
    const input = op.tool === 'snapchat_set_budget' ? setBudgetSchema.parse(op.payload) : setStatusSchema.parse(op.payload);
    const campaigns = await this.client.collection(`campaigns/${input.campaign_id}`, 'campaigns', 'campaign', campaignSchema);
    const current = campaigns.find(c => c.id === input.campaign_id);
    if (!current || current.ad_account_id !== accountId) {
      throw new AdportError('INVALID_INPUT', 'snapchat: campaign does not belong to selected account');
    }
    const field = 'budget_micros' in input ? input.field : 'status';
    const value = 'budget_micros' in input ? input.budget_micros : input.status;
    const previous = current[field];
    const patch = [{ op: previous === undefined ? 'add' : 'replace', path: `/${field}`, value }];
    return {
      summary: `Change Snapchat campaign "${current.name}" ${field}`,
      changes: [`~ ${current.id} ${field}: ${previous ?? 'unset'} → ${value}`], coercions: [],
      budgetDeltas: typeof value === 'number' ? [{ target: `campaign ${current.id} ${field}`, ...(typeof previous === 'number' ? { fromMicros: previous } : {}), toMicros: value }] : [],
      execute: async () => (await this.client.mutate(
        `adaccounts/${accountId}/campaigns/${current.id}`, 'PATCH', patch, 'campaigns', 'campaign', campaignSchema,
      )).map(c => c.id),
    };
  }
}

function normalize(raw: Record<string, number>, metrics: MetricName[]): Partial<Record<MetricName, number>> {
  const mapped: Partial<Record<MetricName, number>> = {};
  const fields = { spend: ['spend', MICROS], impressions: ['impressions', 1], clicks: ['swipes', 1], conversions: ['conversion_purchases', 1], conversion_value: ['conversion_purchases_value', MICROS] } as const;
  for (const [metric, [field, divisor]] of Object.entries(fields)) {
    if (raw[field] !== undefined) mapped[metric as MetricName] = raw[field]! / divisor;
  }
  for (const [metric, numerator, denominator, factor] of [
    ['ctr', 'clicks', 'impressions', 100], ['cpc', 'spend', 'clicks', 1], ['cpm', 'spend', 'impressions', 1000],
    ['cpa', 'spend', 'conversions', 1], ['roas', 'conversion_value', 'spend', 1],
  ] as const) {
    if (mapped[numerator] !== undefined && mapped[denominator] !== undefined) {
      mapped[metric] = mapped[denominator] ? mapped[numerator]! / mapped[denominator]! * factor : 0;
    }
  }
  return Object.fromEntries(metrics.filter(metric => mapped[metric] !== undefined).map(metric => [metric, mapped[metric]]));
}

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** Snap TOTAL stats require account-local day boundaries, including DST changes. */
export function accountMidnight(date: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AdportError('INVALID_INPUT', 'snapchat: invalid report date');
  const target = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== date) throw new AdportError('INVALID_INPUT', 'snapchat: invalid report date');
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let value = target;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(format.formatToParts(new Date(value)).map(p => [p.type, p.value]));
    const rendered = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    if (rendered === target) return new Date(value).toISOString();
    value += target - rendered;
  }
  throw new AdportError('INVALID_INPUT', 'snapchat: account timezone has no midnight for this report date');
}
