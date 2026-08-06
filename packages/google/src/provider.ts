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
  type WriteGuard,
  type WriteOperation,
  type WritePreview,
  type WriteResult,
} from '@adport/core';
import { GoogleAdsRestClient, normalizeCustomerId } from './client.js';

const LEVEL_RESOURCE = {
  account: 'customer',
  campaign: 'campaign',
  ad_group: 'ad_group',
  ad: 'ad_group_ad',
} as const;

/** Base metrics fetched from the API; ratio metrics are derived client-side for consistency. */
const BASE_METRIC_FIELDS: Record<string, string> = {
  spend: 'metrics.cost_micros',
  impressions: 'metrics.impressions',
  clicks: 'metrics.clicks',
  conversions: 'metrics.conversions',
  conversion_value: 'metrics.conversions_value',
};

interface WritePlan {
  summary: string;
  changes: string[];
  coercions: string[];
  budgetDeltas: WritePreview['budgetDeltas'];
  execute: (validateOnly: boolean) => Promise<string[]>;
}

export class GoogleAdsProvider implements AdProvider {
  readonly id = 'google';

  constructor(private readonly client: GoogleAdsRestClient) {}

  capabilities(): ProviderCapabilities {
    return { serverDryRun: true };
  }

  async listAccounts(): Promise<Account[]> {
    const ids = await this.client.listAccessibleCustomers();
    const accounts: Account[] = [];
    for (const id of ids) {
      try {
        const rows = await this.client.search(
          id,
          'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.status, customer.manager FROM customer LIMIT 1',
          { maxRows: 1 },
        );
        const customer = (rows[0]?.customer ?? {}) as {
          descriptiveName?: string;
          currencyCode?: string;
          status?: string;
          manager?: boolean;
        };
        accounts.push({
          provider: this.id,
          id,
          name: customer.descriptiveName ?? `(account ${id})`,
          currency: customer.currencyCode,
          status: customer.manager ? `${customer.status ?? 'UNKNOWN'} (manager)` : customer.status,
        });
      } catch {
        accounts.push({ provider: this.id, id, name: '(details unavailable)', status: 'UNKNOWN' });
      }
    }
    return accounts;
  }

  async report(query: NormalizedQuery): Promise<Report> {
    const range = resolveDateRange(query.dateRange);
    const resource = LEVEL_RESOURCE[query.level];
    const accountIds =
      query.accountIds ??
      (await this.listAccounts()).filter((a) => !a.status?.includes('manager')).map((a) => a.id);

    const baseMetrics = new Set<string>();
    for (const metric of query.metrics) {
      const field = BASE_METRIC_FIELDS[metric];
      if (field) baseMetrics.add(field);
    }
    // Ratio metrics need their inputs.
    const wants = (m: MetricName) => query.metrics.includes(m);
    if (wants('ctr')) ['metrics.clicks', 'metrics.impressions'].forEach((f) => baseMetrics.add(f));
    if (wants('cpc') || wants('cpa') || wants('cpm') || wants('roas')) baseMetrics.add('metrics.cost_micros');
    if (wants('cpc')) baseMetrics.add('metrics.clicks');
    if (wants('cpm')) baseMetrics.add('metrics.impressions');
    if (wants('cpa')) baseMetrics.add('metrics.conversions');
    if (wants('roas')) baseMetrics.add('metrics.conversions_value');

    const entityFields = {
      account: ['customer.id', 'customer.descriptive_name', 'customer.status'],
      campaign: ['campaign.id', 'campaign.name', 'campaign.status'],
      ad_group: ['ad_group.id', 'ad_group.name', 'ad_group.status', 'campaign.name'],
      ad: ['ad_group_ad.ad.id', 'ad_group_ad.status', 'ad_group.name'],
    }[query.level];

    const gaql =
      `SELECT ${[...entityFields, ...baseMetrics].join(', ')} FROM ${resource} ` +
      `WHERE segments.date BETWEEN '${range.start}' AND '${range.end}' ` +
      `PARAMETERS omit_unselected_resource_names=true`;

    const rows: ReportRow[] = [];
    for (const accountId of accountIds) {
      const results = await this.client.search(accountId, gaql, { maxRows: query.limit ?? 1000 });
      for (const row of results) {
        rows.push(this.toReportRow(row, accountId, query));
      }
    }
    return { rows };
  }

  private toReportRow(row: Record<string, unknown>, accountId: string, query: NormalizedQuery): ReportRow {
    const metricsRaw = (row.metrics ?? {}) as Record<string, string | number>;
    const num = (key: string) => Number(metricsRaw[key] ?? 0);
    const spend = num('costMicros') / 1_000_000;
    const impressions = num('impressions');
    const clicks = num('clicks');
    const conversions = num('conversions');
    const conversionValue = num('conversionsValue');
    const all: Record<MetricName, number> = {
      spend: round2(spend),
      impressions,
      clicks,
      conversions,
      conversion_value: round2(conversionValue),
      ctr: impressions > 0 ? round2((clicks / impressions) * 100) : 0,
      cpc: clicks > 0 ? round2(spend / clicks) : 0,
      cpm: impressions > 0 ? round2((spend / impressions) * 1000) : 0,
      cpa: conversions > 0 ? round2(spend / conversions) : 0,
      roas: spend > 0 ? round2(conversionValue / spend) : 0,
    };

    let entity: ReportRow['entity'];
    switch (query.level) {
      case 'account': {
        const customer = (row.customer ?? {}) as { id?: string; descriptiveName?: string; status?: string };
        entity = { level: 'account', id: String(customer.id ?? accountId), name: customer.descriptiveName ?? accountId, status: customer.status };
        break;
      }
      case 'campaign': {
        const campaign = (row.campaign ?? {}) as { id?: string; name?: string; status?: string };
        entity = { level: 'campaign', id: String(campaign.id ?? ''), name: campaign.name ?? '', status: campaign.status };
        break;
      }
      case 'ad_group': {
        const adGroup = (row.adGroup ?? {}) as { id?: string; name?: string; status?: string };
        entity = { level: 'ad_group', id: String(adGroup.id ?? ''), name: adGroup.name ?? '', status: adGroup.status };
        break;
      }
      case 'ad': {
        const adGroupAd = (row.adGroupAd ?? {}) as { ad?: { id?: string }; status?: string };
        entity = { level: 'ad', id: String(adGroupAd.ad?.id ?? ''), name: `ad ${adGroupAd.ad?.id ?? '?'}`, status: adGroupAd.status };
        break;
      }
    }
    return {
      provider: this.id,
      accountId,
      entity,
      metrics: Object.fromEntries(query.metrics.map((m) => [m, all[m]])),
    };
  }

  async gaqlSearch(input: {
    customer_id: string;
    resource: string;
    fields: string[];
    conditions?: string[];
    order_by?: string[];
    limit?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const limit = Math.min(input.limit ?? 200, 10_000);
    let query = `SELECT ${input.fields.join(', ')} FROM ${input.resource}`;
    if (input.conditions?.length) query += ` WHERE ${input.conditions.join(' AND ')}`;
    if (input.order_by?.length) query += ` ORDER BY ${input.order_by.join(', ')}`;
    query += ` LIMIT ${limit} PARAMETERS omit_unselected_resource_names=true`;
    return this.client.search(input.customer_id, query, { maxRows: limit });
  }

  async previewWrite(op: WriteOperation, guard: WriteGuard): Promise<WritePreview> {
    const plan = await this.plan(op, guard);
    await plan.execute(true); // server-side dry run — throws on invalid operations
    return {
      summary: plan.summary,
      changes: plan.changes,
      coercions: plan.coercions,
      budgetDeltas: plan.budgetDeltas,
      serverValidated: true,
    };
  }

  async applyWrite(op: WriteOperation, guard: WriteGuard): Promise<WriteResult> {
    const plan = await this.plan(op, guard);
    const resourceIds = await plan.execute(false);
    return { applied: true, resourceIds };
  }

  // ---- write planning ------------------------------------------------------

  private async plan(op: WriteOperation, guard: WriteGuard): Promise<WritePlan> {
    const cid = normalizeCustomerId(op.accountId);
    // Tool input was already zod-validated at the registry boundary.
    const payload = op.payload as never;
    switch (op.tool) {
      case 'google_create_campaign':
        return this.planCreateCampaign(cid, payload, guard);
      case 'google_set_campaign_status':
        return this.planSetCampaignStatus(cid, payload);
      case 'google_set_budget':
        return this.planSetBudget(cid, payload);
      case 'google_create_ad_group':
        return this.planCreateAdGroup(cid, payload);
      case 'google_set_ad_group_status':
        return this.planSetAdGroupStatus(cid, payload);
      case 'google_add_keywords':
        return this.planAddKeywords(cid, payload);
      case 'google_set_keyword_status':
        return this.planSetKeywordStatus(cid, payload);
      case 'google_remove_keywords':
        return this.planRemoveKeywords(cid, payload);
      case 'google_create_responsive_search_ad':
        return this.planCreateRsa(cid, payload, guard);
      case 'google_set_bid_ceiling':
        return this.planSetBidCeiling(cid, payload);
      case 'google_set_bidding_strategy':
        return this.planSetBiddingStrategy(cid, payload);
      default:
        throw new AdportError('PROVIDER_ERROR', `google: unsupported write tool ${op.tool}`);
    }
  }

  private async planCreateCampaign(
    cid: string,
    payload: { name: string; daily_budget_micros: number; channel_type?: string; status?: string },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const coercions: string[] = [];
    let status = payload.status ?? 'ENABLED';
    if (guard.forcePausedCreation && status === 'ENABLED') {
      status = 'PAUSED';
      coercions.push('status coerced to PAUSED by policy (paused_creation)');
    }
    const channelType = payload.channel_type ?? 'SEARCH';
    const budgetTempResource = `customers/${cid}/campaignBudgets/-1`;
    const mutateOperations = [
      {
        campaignBudgetOperation: {
          create: {
            resourceName: budgetTempResource,
            name: `Budget for ${payload.name} (${Date.now()})`,
            amountMicros: String(payload.daily_budget_micros),
            deliveryMethod: 'STANDARD',
            explicitlyShared: false,
          },
        },
      },
      {
        campaignOperation: {
          create: {
            name: payload.name,
            status,
            advertisingChannelType: channelType,
            manualCpc: {},
            campaignBudget: budgetTempResource,
          },
        },
      },
    ];
    return {
      summary: `Create ${channelType} campaign "${payload.name}" (${status}), daily budget ${payload.daily_budget_micros} micros`,
      changes: [
        `+ campaign_budget ${payload.daily_budget_micros} micros/day (not shared)`,
        `+ campaign "${payload.name}" status=${status} channel=${channelType} bidding=manual_cpc`,
      ],
      coercions,
      budgetDeltas: [{ target: `new campaign "${payload.name}" daily budget`, toMicros: payload.daily_budget_micros }],
      execute: async (validateOnly) => {
        const res = await this.client.googleAdsMutate(cid, mutateOperations, { validateOnly });
        return (res.mutateOperationResponses ?? [])
          .flatMap((r) => Object.values(r).map((v) => v.resourceName))
          .filter((r): r is string => Boolean(r));
      },
    };
  }

  private async planSetCampaignStatus(
    cid: string,
    payload: { campaign_id: string; status: 'ENABLED' | 'PAUSED' },
  ): Promise<WritePlan> {
    const current = await this.lookupCampaign(cid, payload.campaign_id);
    const resourceName = `customers/${cid}/campaigns/${payload.campaign_id}`;
    return {
      summary: `Set campaign "${current.name}" status ${current.status} → ${payload.status}`,
      changes: [`~ campaign ${payload.campaign_id} status ${current.status} → ${payload.status}`],
      coercions: [],
      budgetDeltas: [],
      execute: async (validateOnly) => {
        const res = await this.client.mutate(
          cid,
          'campaigns',
          [{ update: { resourceName, status: payload.status }, updateMask: 'status' }],
          { validateOnly },
        );
        return (res.results ?? []).map((r) => r.resourceName ?? resourceName);
      },
    };
  }

  private async planSetBudget(
    cid: string,
    payload: { campaign_id: string; daily_budget_micros: number },
  ): Promise<WritePlan> {
    const current = await this.lookupCampaign(cid, payload.campaign_id);
    const changes = [
      `~ campaign_budget ${current.budgetResource} amount ${current.budgetMicros} → ${payload.daily_budget_micros}`,
    ];
    if (current.budgetShared) {
      changes.push('! this budget is SHARED — the change affects every campaign using it');
    }
    return {
      summary: `Change "${current.name}" daily budget ${current.budgetMicros} → ${payload.daily_budget_micros} micros`,
      changes,
      coercions: [],
      budgetDeltas: [
        {
          target: `campaign "${current.name}" daily budget`,
          fromMicros: current.budgetMicros,
          toMicros: payload.daily_budget_micros,
        },
      ],
      execute: async (validateOnly) => {
        const res = await this.client.mutate(
          cid,
          'campaignBudgets',
          [
            {
              update: {
                resourceName: current.budgetResource,
                amountMicros: String(payload.daily_budget_micros),
              },
              updateMask: 'amount_micros',
            },
          ],
          { validateOnly },
        );
        return (res.results ?? []).map((r) => r.resourceName ?? current.budgetResource);
      },
    };
  }

  private async planCreateAdGroup(
    cid: string,
    payload: { campaign_id: string; name: string; cpc_bid_micros?: number },
  ): Promise<WritePlan> {
    const campaign = await this.lookupCampaign(cid, payload.campaign_id);
    const create: Record<string, unknown> = {
      name: payload.name,
      campaign: `customers/${cid}/campaigns/${payload.campaign_id}`,
      status: 'ENABLED',
      type: 'SEARCH_STANDARD',
    };
    if (payload.cpc_bid_micros) create.cpcBidMicros = String(payload.cpc_bid_micros);
    return {
      summary: `Create ad group "${payload.name}" in campaign "${campaign.name}"`,
      changes: [`+ ad_group "${payload.name}" in campaign ${payload.campaign_id} (ENABLED — inherits campaign state)`],
      coercions: [],
      budgetDeltas: [],
      execute: async (validateOnly) => {
        const res = await this.client.mutate(cid, 'adGroups', [{ create }], { validateOnly });
        return (res.results ?? []).map((r) => r.resourceName ?? '');
      },
    };
  }

  private async planSetAdGroupStatus(
    cid: string,
    payload: { ad_group_id: string; status: 'ENABLED' | 'PAUSED' },
  ): Promise<WritePlan> {
    const resourceName = `customers/${cid}/adGroups/${payload.ad_group_id}`;
    return {
      summary: `Set ad group ${payload.ad_group_id} status → ${payload.status}`,
      changes: [`~ ad_group ${payload.ad_group_id} status → ${payload.status}`],
      coercions: [],
      budgetDeltas: [],
      execute: async (validateOnly) => {
        const res = await this.client.mutate(
          cid,
          'adGroups',
          [{ update: { resourceName, status: payload.status }, updateMask: 'status' }],
          { validateOnly },
        );
        return (res.results ?? []).map((r) => r.resourceName ?? resourceName);
      },
    };
  }

  private async planAddKeywords(
    cid: string,
    payload: { ad_group_id: string; keywords: Array<{ text: string; match_type: string }>; negative?: boolean },
  ): Promise<WritePlan> {
    const operations = payload.keywords.map((kw) => ({
      create: {
        adGroup: `customers/${cid}/adGroups/${payload.ad_group_id}`,
        status: 'ENABLED',
        negative: payload.negative ?? false,
        keyword: { text: kw.text, matchType: kw.match_type },
      },
    }));
    const kind = payload.negative ? 'negative keywords' : 'keywords';
    return {
      summary: `Add ${payload.keywords.length} ${kind} to ad group ${payload.ad_group_id}`,
      changes: payload.keywords.map((kw) => `+ ${payload.negative ? 'negative ' : ''}keyword [${kw.match_type}] "${kw.text}"`),
      coercions: [],
      budgetDeltas: [],
      execute: async (validateOnly) => {
        const res = await this.client.mutate(cid, 'adGroupCriteria', operations, { validateOnly });
        return (res.results ?? []).map((r) => r.resourceName ?? '');
      },
    };
  }

  private async planSetKeywordStatus(
    cid: string,
    payload: { ad_group_id: string; criterion_id: string; status: 'ENABLED' | 'PAUSED' },
  ): Promise<WritePlan> {
    const resourceName = `customers/${cid}/adGroupCriteria/${payload.ad_group_id}~${payload.criterion_id}`;
    return {
      summary: `Set keyword criterion ${payload.criterion_id} status → ${payload.status}`,
      changes: [`~ ad_group_criterion ${payload.ad_group_id}~${payload.criterion_id} status → ${payload.status}`],
      coercions: [],
      budgetDeltas: [],
      execute: async (validateOnly) => {
        const res = await this.client.mutate(
          cid,
          'adGroupCriteria',
          [{ update: { resourceName, status: payload.status }, updateMask: 'status' }],
          { validateOnly },
        );
        return (res.results ?? []).map((r) => r.resourceName ?? resourceName);
      },
    };
  }

  private async planRemoveKeywords(
    cid: string,
    payload: { ad_group_id: string; criterion_ids: string[] },
  ): Promise<WritePlan> {
    const resourceNames = payload.criterion_ids.map(
      (id) => `customers/${cid}/adGroupCriteria/${payload.ad_group_id}~${id}`,
    );
    return {
      summary: `PERMANENTLY remove ${resourceNames.length} keyword criteria from ad group ${payload.ad_group_id}`,
      changes: resourceNames.map((r) => `- ${r}`),
      coercions: [],
      budgetDeltas: [],
      execute: async (validateOnly) => {
        const res = await this.client.mutate(
          cid,
          'adGroupCriteria',
          resourceNames.map((remove) => ({ remove })),
          { validateOnly },
        );
        return (res.results ?? []).map((r) => r.resourceName ?? '');
      },
    };
  }

  private async planCreateRsa(
    cid: string,
    payload: {
      ad_group_id: string;
      headlines: string[];
      descriptions: string[];
      final_urls: string[];
      path1?: string;
      path2?: string;
    },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    validateRsa(payload);
    const coercions: string[] = [];
    // RSAs always start paused (matches the reference implementation) unless policy says otherwise.
    const status = guard.forcePausedCreation ? 'PAUSED' : 'ENABLED';
    if (guard.forcePausedCreation) coercions.push('ad created PAUSED by policy (paused_creation)');
    const create = {
      adGroup: `customers/${cid}/adGroups/${payload.ad_group_id}`,
      status,
      ad: {
        finalUrls: payload.final_urls,
        responsiveSearchAd: {
          headlines: payload.headlines.map((text) => ({ text })),
          descriptions: payload.descriptions.map((text) => ({ text })),
          ...(payload.path1 ? { path1: payload.path1 } : {}),
          ...(payload.path2 ? { path2: payload.path2 } : {}),
        },
      },
    };
    return {
      summary: `Create responsive search ad (${payload.headlines.length} headlines, ${payload.descriptions.length} descriptions) in ad group ${payload.ad_group_id}`,
      changes: [`+ responsive_search_ad in ad_group ${payload.ad_group_id} status=${status}`],
      coercions,
      budgetDeltas: [],
      execute: async (validateOnly) => {
        const res = await this.client.mutate(cid, 'adGroupAds', [{ create }], { validateOnly });
        return (res.results ?? []).map((r) => r.resourceName ?? '');
      },
    };
  }

  /** CPC ceilings exist on TARGET_SPEND (Maximize clicks) and TARGET_IMPRESSION_SHARE. */
  private async planSetBidCeiling(
    cid: string,
    payload: { campaign_id: string; cpc_bid_ceiling_micros: number },
  ): Promise<WritePlan> {
    const current = await this.lookupCampaignBidding(cid, payload.campaign_id);
    const resourceName = `customers/${cid}/campaigns/${payload.campaign_id}`;
    let update: Record<string, unknown>;
    let updateMask: string;
    if (current.strategyType === 'TARGET_SPEND') {
      update = { resourceName, targetSpend: { cpcBidCeilingMicros: String(payload.cpc_bid_ceiling_micros) } };
      updateMask = 'target_spend.cpc_bid_ceiling_micros';
    } else if (current.strategyType === 'TARGET_IMPRESSION_SHARE') {
      update = {
        resourceName,
        targetImpressionShare: { cpcBidCeilingMicros: String(payload.cpc_bid_ceiling_micros) },
      };
      updateMask = 'target_impression_share.cpc_bid_ceiling_micros';
    } else {
      throw new AdportError(
        'PROVIDER_ERROR',
        `google: campaign "${current.name}" uses ${current.strategyType} bidding, which has no CPC bid ceiling. ` +
          'Use google_set_bidding_strategy to switch strategy (e.g. MAXIMIZE_CLICKS supports a ceiling).',
      );
    }
    // Note: bid ceilings are deliberately NOT reported as budgetDeltas — the
    // budget-delta policy cap targets budgets; bid tuning routinely moves >25%.
    return {
      summary:
        `Set "${current.name}" CPC bid ceiling ` +
        `${current.cpcBidCeilingMicros ?? '(unset)'} → ${payload.cpc_bid_ceiling_micros} micros (${current.strategyType})`,
      changes: [
        `~ campaign ${payload.campaign_id} ${updateMask} ${current.cpcBidCeilingMicros ?? '(unset)'} → ${payload.cpc_bid_ceiling_micros}`,
      ],
      coercions: [],
      budgetDeltas: [],
      execute: async (validateOnly) => {
        const res = await this.client.mutate(cid, 'campaigns', [{ update, updateMask }], { validateOnly });
        return (res.results ?? []).map((r) => r.resourceName ?? resourceName);
      },
    };
  }

  private async planSetBiddingStrategy(
    cid: string,
    payload: {
      campaign_id: string;
      strategy: 'MANUAL_CPC' | 'MAXIMIZE_CLICKS' | 'MAXIMIZE_CONVERSIONS' | 'MAXIMIZE_CONVERSION_VALUE';
      target_cpa_micros?: number;
      target_roas?: number;
      cpc_bid_ceiling_micros?: number;
    },
  ): Promise<WritePlan> {
    if (payload.target_cpa_micros && payload.strategy !== 'MAXIMIZE_CONVERSIONS') {
      throw new AdportError('INVALID_INPUT', 'target_cpa_micros only applies to MAXIMIZE_CONVERSIONS');
    }
    if (payload.target_roas && payload.strategy !== 'MAXIMIZE_CONVERSION_VALUE') {
      throw new AdportError('INVALID_INPUT', 'target_roas only applies to MAXIMIZE_CONVERSION_VALUE');
    }
    if (payload.cpc_bid_ceiling_micros && payload.strategy !== 'MAXIMIZE_CLICKS') {
      throw new AdportError('INVALID_INPUT', 'cpc_bid_ceiling_micros only applies to MAXIMIZE_CLICKS (target spend)');
    }
    const current = await this.lookupCampaignBidding(cid, payload.campaign_id);
    const resourceName = `customers/${cid}/campaigns/${payload.campaign_id}`;

    let strategyField: Record<string, unknown>;
    let updateMask: string;
    const details: string[] = [];
    switch (payload.strategy) {
      case 'MANUAL_CPC':
        strategyField = { manualCpc: {} };
        updateMask = 'manual_cpc';
        break;
      case 'MAXIMIZE_CLICKS':
        strategyField = {
          targetSpend: payload.cpc_bid_ceiling_micros
            ? { cpcBidCeilingMicros: String(payload.cpc_bid_ceiling_micros) }
            : {},
        };
        updateMask = payload.cpc_bid_ceiling_micros ? 'target_spend.cpc_bid_ceiling_micros' : 'target_spend';
        if (payload.cpc_bid_ceiling_micros) details.push(`ceiling ${payload.cpc_bid_ceiling_micros} micros`);
        break;
      case 'MAXIMIZE_CONVERSIONS':
        strategyField = {
          maximizeConversions: payload.target_cpa_micros
            ? { targetCpaMicros: String(payload.target_cpa_micros) }
            : {},
        };
        updateMask = payload.target_cpa_micros ? 'maximize_conversions.target_cpa_micros' : 'maximize_conversions';
        if (payload.target_cpa_micros) details.push(`target CPA ${payload.target_cpa_micros} micros`);
        break;
      case 'MAXIMIZE_CONVERSION_VALUE':
        strategyField = {
          maximizeConversionValue: payload.target_roas ? { targetRoas: payload.target_roas } : {},
        };
        updateMask = payload.target_roas ? 'maximize_conversion_value.target_roas' : 'maximize_conversion_value';
        if (payload.target_roas) details.push(`target ROAS ${payload.target_roas}`);
        break;
    }
    return {
      summary:
        `Switch "${current.name}" bidding ${current.strategyType} → ${payload.strategy}` +
        (details.length > 0 ? ` (${details.join(', ')})` : ''),
      changes: [`~ campaign ${payload.campaign_id} bidding_strategy ${current.strategyType} → ${payload.strategy}`],
      coercions: [],
      budgetDeltas: [],
      execute: async (validateOnly) => {
        const res = await this.client.mutate(
          cid,
          'campaigns',
          [{ update: { resourceName, ...strategyField }, updateMask }],
          { validateOnly },
        );
        return (res.results ?? []).map((r) => r.resourceName ?? resourceName);
      },
    };
  }

  private async lookupCampaignBidding(
    cid: string,
    campaignId: string,
  ): Promise<{ name: string; strategyType: string; cpcBidCeilingMicros?: number }> {
    const rows = await this.client.search(
      cid,
      `SELECT campaign.name, campaign.bidding_strategy_type, campaign.target_spend.cpc_bid_ceiling_micros, campaign.target_impression_share.cpc_bid_ceiling_micros FROM campaign WHERE campaign.id = ${Number(campaignId)} LIMIT 1`,
      { maxRows: 1 },
    );
    const row = rows[0];
    if (!row) {
      throw new AdportError('PROVIDER_ERROR', `google: campaign ${campaignId} not found in account ${cid}`);
    }
    const campaign = row.campaign as {
      name?: string;
      biddingStrategyType?: string;
      targetSpend?: { cpcBidCeilingMicros?: string };
      targetImpressionShare?: { cpcBidCeilingMicros?: string };
    };
    const ceiling =
      campaign.targetSpend?.cpcBidCeilingMicros ?? campaign.targetImpressionShare?.cpcBidCeilingMicros;
    return {
      name: campaign.name ?? campaignId,
      strategyType: campaign.biddingStrategyType ?? 'UNKNOWN',
      cpcBidCeilingMicros: ceiling !== undefined ? Number(ceiling) : undefined,
    };
  }

  private async lookupCampaign(
    cid: string,
    campaignId: string,
  ): Promise<{ name: string; status: string; budgetResource: string; budgetMicros: number; budgetShared: boolean }> {
    const rows = await this.client.search(
      cid,
      `SELECT campaign.name, campaign.status, campaign.campaign_budget, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${Number(campaignId)} LIMIT 1`,
      { maxRows: 1 },
    );
    const row = rows[0];
    if (!row) {
      throw new AdportError('PROVIDER_ERROR', `google: campaign ${campaignId} not found in account ${cid}`);
    }
    const campaign = row.campaign as { name?: string; status?: string };
    const budget = (row.campaignBudget ?? {}) as {
      resourceName?: string;
      amountMicros?: string;
      explicitlyShared?: boolean;
    };
    return {
      name: campaign.name ?? campaignId,
      status: campaign.status ?? 'UNKNOWN',
      budgetResource: budget.resourceName ?? '',
      budgetMicros: Number(budget.amountMicros ?? 0),
      budgetShared: budget.explicitlyShared ?? false,
    };
  }
}

function validateRsa(payload: { headlines: string[]; descriptions: string[]; final_urls: string[] }): void {
  const problems: string[] = [];
  if (payload.headlines.length < 3 || payload.headlines.length > 15) problems.push('3–15 headlines required');
  if (payload.descriptions.length < 2 || payload.descriptions.length > 4) problems.push('2–4 descriptions required');
  if (payload.final_urls.length < 1) problems.push('at least one final_url required');
  for (const h of payload.headlines) if (h.length > 30) problems.push(`headline over 30 chars: "${h}"`);
  for (const d of payload.descriptions) if (d.length > 90) problems.push(`description over 90 chars: "${d}"`);
  if (problems.length > 0) {
    throw new AdportError('INVALID_INPUT', `Responsive search ad invalid: ${problems.join('; ')}`);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
