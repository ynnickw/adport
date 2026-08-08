import {
  AdportError,
  resolveDateRange,
  type Account,
  type AdProvider,
  type MetricName,
  type NormalizedQuery,
  type ProviderCapabilities,
  type Report,
  type ReportRow,
  type StandardActions,
  type WriteGuard,
  type WriteOperation,
  type WritePreview,
  type WriteResult,
} from '@adport/core';
import { AppleAdsClient } from './client.js';

/** Apple Money amounts are strings in whole currency units. */
export const UNITS_TO_MICROS = 1_000_000;

interface Money {
  amount: string;
  currency: string;
}

interface AppleCampaign {
  id: number;
  name: string;
  status: 'ENABLED' | 'PAUSED';
  servingStatus?: string;
  displayStatus?: string;
  dailyBudgetAmount?: Money;
  adamId?: number;
  countriesOrRegions?: string[];
  billingEvent?: string;
  supplySources?: string[];
}

interface SpendRow {
  impressions?: number;
  taps?: number;
  ttr?: number;
  totalInstalls?: number;
  localSpend?: Money;
  tapInstallCPI?: Money;
  tapInstallRate?: number;
}

interface ReportingRow {
  other?: boolean;
  total?: SpendRow;
  metadata?: { campaignId?: number; campaignName?: string; campaignStatus?: string };
}

interface WritePlan {
  summary: string;
  changes: string[];
  coercions: string[];
  budgetDeltas: WritePreview['budgetDeltas'];
  execute: () => Promise<string[]>;
}

export class AppleAdsProvider implements AdProvider {
  readonly id = 'apple';

  constructor(private readonly client: AppleAdsClient) {}

  capabilities(): ProviderCapabilities {
    // No validate-only mode in the Campaign Management API — client-side previews.
    return { serverDryRun: false };
  }

  standardActions(): StandardActions {
    return {
      pauseCampaign: (accountId, campaignId) => ({
        tool: 'apple_set_campaign_status',
        input: { account_id: accountId, campaign_id: campaignId, status: 'PAUSED' },
      }),
    };
  }

  /** Apple "accounts" are organizations from the user ACL. */
  async listAccounts(): Promise<Account[]> {
    const envelope = await this.client.request<
      Array<{ orgId: number; orgName: string; currency?: string; roleNames?: string[]; timeZone?: string }>
    >('GET', 'acls');
    return (envelope.data ?? []).map((acl) => ({
      provider: this.id,
      id: String(acl.orgId),
      name: acl.orgName,
      currency: acl.currency,
      status: acl.roleNames?.join(',') || undefined,
    }));
  }

  async listCampaigns(orgId: string, limit = 100): Promise<AppleCampaign[]> {
    const envelope = await this.client.request<AppleCampaign[]>('GET', `campaigns?limit=${limit}&offset=0`, {
      orgId,
    });
    return envelope.data ?? [];
  }

  async getCampaign(orgId: string, campaignId: string): Promise<AppleCampaign> {
    const envelope = await this.client.request<AppleCampaign[]>('POST', 'campaigns/find', {
      orgId,
      body: {
        conditions: [{ field: 'id', operator: 'EQUALS', values: [String(campaignId)] }],
        pagination: { offset: 0, limit: 1 },
      },
    });
    const campaign = envelope.data?.[0];
    if (!campaign) {
      throw new AdportError('PROVIDER_ERROR', `apple: campaign ${campaignId} not found in org ${orgId}`);
    }
    return campaign;
  }

  async report(query: NormalizedQuery): Promise<Report> {
    if (query.level !== 'campaign' && query.level !== 'account') {
      throw new AdportError('INVALID_INPUT', 'apple: report supports campaign and account levels in v0');
    }
    const range = resolveDateRange(query.dateRange);
    const accountIds = query.accountIds ?? (await this.listAccounts()).map((a) => a.id);
    const rows: ReportRow[] = [];
    for (const orgId of accountIds) {
      const envelope = await this.client.request<{ reportingDataResponse?: { row?: ReportingRow[] } }>(
        'POST',
        'reports/campaigns',
        {
          orgId,
          body: {
            startTime: range.start,
            endTime: range.end,
            selector: {
              orderBy: [{ field: 'campaignId', sortOrder: 'ASCENDING' }],
              pagination: { offset: 0, limit: Math.min(query.limit ?? 200, 1000) },
            },
            timeZone: 'UTC',
            returnRowTotals: true,
            returnGrandTotals: true,
            returnRecordsWithNoMetrics: false,
          },
        },
      );
      for (const row of envelope.data?.reportingDataResponse?.row ?? []) {
        rows.push(this.toReportRow(row, orgId, query));
      }
    }
    return { rows };
  }

  private toReportRow(row: ReportingRow, orgId: string, query: NormalizedQuery): ReportRow {
    const total = row.total ?? {};
    const spend = Number(total.localSpend?.amount ?? 0);
    const impressions = total.impressions ?? 0;
    // Apple has taps, not clicks; installs are the conversion event. No revenue metric exists.
    const clicks = total.taps ?? 0;
    const conversions = total.totalInstalls ?? 0;
    const all: Record<MetricName, number> = {
      spend: round2(spend),
      impressions,
      clicks,
      conversions,
      conversion_value: 0,
      ctr: impressions > 0 ? round2((clicks / impressions) * 100) : 0,
      cpc: clicks > 0 ? round2(spend / clicks) : 0,
      cpm: impressions > 0 ? round2((spend / impressions) * 1000) : 0,
      cpa: conversions > 0 ? round2(spend / conversions) : 0,
      roas: 0,
    };
    return {
      provider: this.id,
      accountId: orgId,
      entity: {
        level: 'campaign',
        id: String(row.metadata?.campaignId ?? ''),
        name: row.metadata?.campaignName ?? '',
        status: row.metadata?.campaignStatus,
      },
      metrics: Object.fromEntries(query.metrics.map((m) => [m, all[m]])),
    };
  }

  async previewWrite(op: WriteOperation, guard: WriteGuard): Promise<WritePreview> {
    const plan = await this.plan(op, guard);
    return {
      summary: plan.summary,
      changes: plan.changes,
      coercions: plan.coercions,
      budgetDeltas: plan.budgetDeltas,
      serverValidated: false,
    };
  }

  async applyWrite(op: WriteOperation, guard: WriteGuard): Promise<WriteResult> {
    const plan = await this.plan(op, guard);
    const resourceIds = await plan.execute();
    return { applied: true, resourceIds };
  }

  private async plan(op: WriteOperation, guard: WriteGuard): Promise<WritePlan> {
    const payload = op.payload as never;
    switch (op.tool) {
      case 'apple_create_campaign':
        return this.planCreateCampaign(op.accountId, payload, guard);
      case 'apple_set_campaign_status':
        return this.planSetStatus(op.accountId, payload);
      case 'apple_set_budget':
        return this.planSetBudget(op.accountId, payload);
      default:
        throw new AdportError('PROVIDER_ERROR', `apple: unsupported write tool ${op.tool}`);
    }
  }

  private async planCreateCampaign(
    orgId: string,
    payload: {
      name: string;
      adam_id: number;
      countries_or_regions: string[];
      daily_budget: number;
      currency: string;
      status?: string;
    },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const coercions: string[] = [];
    let status = payload.status ?? 'ENABLED';
    if (guard.forcePausedCreation && status === 'ENABLED') {
      status = 'PAUSED';
      coercions.push('status coerced to PAUSED by policy (paused_creation)');
    }
    // budgetAmount (lifetime) was removed in v5.6 — dailyBudgetAmount only.
    const body = {
      orgId: Number(orgId),
      name: payload.name,
      adamId: payload.adam_id,
      countriesOrRegions: payload.countries_or_regions,
      dailyBudgetAmount: { amount: String(payload.daily_budget), currency: payload.currency },
      adChannelType: 'SEARCH',
      billingEvent: 'TAPS',
      supplySources: ['APPSTORE_SEARCH_RESULTS'],
      status,
    };
    return {
      summary: `Create Apple Ads campaign "${payload.name}" (${status}) — daily budget ${payload.daily_budget} ${payload.currency}`,
      changes: [
        `+ campaign "${payload.name}" app=${payload.adam_id} regions=[${payload.countries_or_regions.join(', ')}] status=${status}`,
      ],
      coercions,
      budgetDeltas: [
        { target: `new campaign "${payload.name}" daily budget`, toMicros: payload.daily_budget * UNITS_TO_MICROS },
      ],
      execute: async () => {
        const envelope = await this.client.request<AppleCampaign>('POST', 'campaigns', { orgId, body });
        return envelope.data?.id ? [String(envelope.data.id)] : [];
      },
    };
  }

  private async planSetStatus(
    orgId: string,
    payload: { campaign_id: string; status: 'ENABLED' | 'PAUSED' },
  ): Promise<WritePlan> {
    const current = await this.getCampaign(orgId, payload.campaign_id);
    return {
      summary: `Set Apple campaign "${current.name}" status ${current.status} → ${payload.status}`,
      changes: [`~ campaign ${payload.campaign_id} status ${current.status} → ${payload.status}`],
      coercions: [],
      budgetDeltas: [],
      execute: async () => {
        await this.client.request('PUT', `campaigns/${payload.campaign_id}`, {
          orgId,
          body: { campaign: { status: payload.status } },
        });
        return [payload.campaign_id];
      },
    };
  }

  private async planSetBudget(
    orgId: string,
    payload: { campaign_id: string; daily_budget: number },
  ): Promise<WritePlan> {
    const current = await this.getCampaign(orgId, payload.campaign_id);
    const fromAmount = current.dailyBudgetAmount ? Number(current.dailyBudgetAmount.amount) : undefined;
    const currency = current.dailyBudgetAmount?.currency ?? 'USD';
    return {
      summary: `Change Apple campaign "${current.name}" daily budget ${fromAmount ?? '(unset)'} → ${payload.daily_budget} ${currency}`,
      changes: [`~ campaign ${payload.campaign_id} dailyBudgetAmount ${fromAmount ?? '(unset)'} → ${payload.daily_budget}`],
      coercions: [],
      budgetDeltas: [
        {
          target: `campaign "${current.name}" daily budget`,
          ...(fromAmount !== undefined ? { fromMicros: fromAmount * UNITS_TO_MICROS } : {}),
          toMicros: payload.daily_budget * UNITS_TO_MICROS,
        },
      ],
      execute: async () => {
        await this.client.request('PUT', `campaigns/${payload.campaign_id}`, {
          orgId,
          body: { campaign: { dailyBudgetAmount: { amount: String(payload.daily_budget), currency } } },
        });
        return [payload.campaign_id];
      },
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
