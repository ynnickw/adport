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
import { ACCOUNT_STATUS, MetaGraphClient, normalizeAccountId } from './client.js';

/** Meta budgets are minor currency units (cents); the policy engine speaks micros. */
export const CENTS_TO_MICROS = 10_000;

const INSIGHTS_LEVEL = {
  account: 'account',
  campaign: 'campaign',
  ad_group: 'adset',
  ad: 'ad',
} as const;

interface ActionStat {
  action_type: string;
  value: string;
}

interface InsightsRow {
  account_id?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: ActionStat[];
  action_values?: ActionStat[];
}

interface WritePlan {
  summary: string;
  changes: string[];
  coercions: string[];
  budgetDeltas: WritePreview['budgetDeltas'];
  execute: (validateOnly: boolean) => Promise<string[]>;
  serverValidated?: boolean;
}

export class MetaAdsProvider implements AdProvider {
  readonly id = 'meta';

  constructor(private readonly client: MetaGraphClient) {}

  capabilities(): ProviderCapabilities {
    return { serverDryRun: true };
  }

  standardActions(): StandardActions {
    return {
      pauseCampaign: (accountId, campaignId) => ({
        tool: 'meta_set_campaign_status',
        input: { account_id: accountId, campaign_id: campaignId, status: 'PAUSED' },
      }),
    };
  }

  async listAccounts(): Promise<Account[]> {
    const rows = await this.client.getPaged<{
      account_id?: string;
      name?: string;
      currency?: string;
      account_status?: number;
    }>('me/adaccounts', { fields: 'account_id,name,currency,account_status', limit: '100' }, 500);
    return rows.map((row) => ({
      provider: this.id,
      id: row.account_id ?? '',
      name: row.name ?? `(account ${row.account_id})`,
      currency: row.currency,
      status: row.account_status !== undefined ? (ACCOUNT_STATUS[row.account_status] ?? String(row.account_status)) : undefined,
    }));
  }

  async report(query: NormalizedQuery): Promise<Report> {
    const range = resolveDateRange(query.dateRange);
    const level = INSIGHTS_LEVEL[query.level];
    const accountIds = query.accountIds ?? (await this.listAccounts()).map((a) => a.id);

    const idFields = {
      account: ['account_id'],
      campaign: ['campaign_id', 'campaign_name'],
      adset: ['adset_id', 'adset_name'],
      ad: ['ad_id', 'ad_name'],
    }[level];
    const fields = [...idFields, 'spend', 'impressions', 'clicks', 'actions', 'action_values'].join(',');

    const rows: ReportRow[] = [];
    for (const accountId of accountIds) {
      const act = normalizeAccountId(accountId);
      const results = await this.client.getPaged<InsightsRow>(
        `act_${act}/insights`,
        {
          level,
          fields,
          time_range: JSON.stringify({ since: range.start, until: range.end }),
          limit: '100',
        },
        query.limit ?? 1000,
      );
      for (const row of results) {
        rows.push(this.toReportRow(row, act, query));
      }
    }
    return { rows };
  }

  private toReportRow(row: InsightsRow, accountId: string, query: NormalizedQuery): ReportRow {
    // Insights values are strings; spend is whole currency units (not cents).
    const spend = Number(row.spend ?? 0);
    const impressions = Number(row.impressions ?? 0);
    const clicks = Number(row.clicks ?? 0);
    // omni_purchase is Meta's canonical cross-channel purchase action.
    const conversions = actionValue(row.actions, 'omni_purchase');
    const conversionValue = actionValue(row.action_values, 'omni_purchase');
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

    const entity: ReportRow['entity'] =
      query.level === 'account'
        ? { level: 'account', id: accountId, name: accountId }
        : query.level === 'campaign'
          ? { level: 'campaign', id: row.campaign_id ?? '', name: row.campaign_name ?? '' }
          : query.level === 'ad_group'
            ? { level: 'ad_group', id: row.adset_id ?? '', name: row.adset_name ?? '' }
            : { level: 'ad', id: row.ad_id ?? '', name: row.ad_name ?? `ad ${row.ad_id ?? '?'}` };

    return {
      provider: this.id,
      accountId,
      entity,
      metrics: Object.fromEntries(query.metrics.map((m) => [m, all[m]])),
    };
  }

  async insights(input: {
    account_id: string;
    level: 'account' | 'campaign' | 'adset' | 'ad';
    fields: string[];
    date_preset?: string;
    time_range?: { since: string; until: string };
    breakdowns?: string[];
    limit?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const act = normalizeAccountId(input.account_id);
    const params: Record<string, string> = {
      level: input.level,
      fields: input.fields.join(','),
      limit: '100',
    };
    if (input.time_range) params.time_range = JSON.stringify(input.time_range);
    else params.date_preset = input.date_preset ?? 'last_30d';
    if (input.breakdowns?.length) params.breakdowns = input.breakdowns.join(',');
    return this.client.getPaged(`act_${act}/insights`, params, Math.min(input.limit ?? 200, 5000));
  }

  async apiRead(input: {
    account_id: string;
    edge: string;
    fields?: string[];
    params?: Record<string, string>;
    limit?: number;
    paged?: boolean;
  }): Promise<unknown> {
    const act = normalizeAccountId(input.account_id);
    const edge = validateMetaEdge(input.edge);
    const params = { ...input.params, ...(input.fields?.length ? { fields: input.fields.join(',') } : {}) };
    return input.paged === false
      ? this.client.get(`act_${act}/${edge}`, params)
      : this.client.getPaged(`act_${act}/${edge}`, params, Math.min(input.limit ?? 200, 5000));
  }

  async previewWrite(op: WriteOperation, guard: WriteGuard): Promise<WritePreview> {
    const plan = await this.plan(op, guard);
    const serverValidated = plan.serverValidated ?? true;
    if (serverValidated) await plan.execute(true); // execution_options=["validate_only"]
    return {
      summary: plan.summary,
      changes: plan.changes,
      coercions: plan.coercions,
      budgetDeltas: plan.budgetDeltas,
      serverValidated,
    };
  }

  async applyWrite(op: WriteOperation, guard: WriteGuard): Promise<WriteResult> {
    const plan = await this.plan(op, guard);
    const resourceIds = await plan.execute(false);
    return { applied: true, resourceIds };
  }

  // ---- write planning ------------------------------------------------------

  private async plan(op: WriteOperation, guard: WriteGuard): Promise<WritePlan> {
    const act = normalizeAccountId(op.accountId);
    const payload = op.payload as never;
    switch (op.tool) {
      case 'meta_create_campaign':
        return this.planCreateCampaign(act, payload, guard);
      case 'meta_set_campaign_status':
        return this.planSetStatus(payload, 'campaign');
      case 'meta_set_budget':
        return this.planSetBudget(payload);
      case 'meta_create_ad_set':
        return this.planCreateAdSet(act, payload, guard);
      case 'meta_set_ad_set_status':
        return this.planSetStatus(payload, 'ad set');
      case 'meta_set_lifetime_budget':
        return this.planSetLifetimeBudget(payload);
      case 'meta_api_create':
        return this.planApiCreate(act, payload, guard);
      case 'meta_api_update':
        return this.planApiUpdate(act, payload);
      case 'meta_api_delete':
        return this.planApiDelete(act, payload);
      default:
        throw new AdportError('PROVIDER_ERROR', `meta: unsupported write tool ${op.tool}`);
    }
  }

  private async planSetLifetimeBudget(payload: { object_id: string; lifetime_budget_cents: number }): Promise<WritePlan> {
    const current = await this.client.get<{ name?: string; lifetime_budget?: string }>(payload.object_id, {
      fields: 'name,lifetime_budget',
    });
    const fromCents = current.lifetime_budget !== undefined ? Number(current.lifetime_budget) : undefined;
    if (fromCents === undefined) {
      throw new AdportError('PROVIDER_ERROR', `meta: object ${payload.object_id} has no lifetime_budget`);
    }
    return {
      summary: `Change "${current.name ?? payload.object_id}" lifetime budget ${fromCents} → ${payload.lifetime_budget_cents} minor units`,
      changes: [`~ ${payload.object_id} lifetime_budget ${fromCents} → ${payload.lifetime_budget_cents}`],
      coercions: [],
      budgetDeltas: [{
        target: `"${current.name ?? payload.object_id}" lifetime budget`,
        fromMicros: fromCents * CENTS_TO_MICROS,
        toMicros: payload.lifetime_budget_cents * CENTS_TO_MICROS,
      }],
      execute: async (validateOnly) => {
        await this.client.post(payload.object_id, this.withExecutionOptions({ lifetime_budget: payload.lifetime_budget_cents }, validateOnly));
        return [payload.object_id];
      },
    };
  }

  private async planApiCreate(
    act: string,
    payload: { edge: string; fields: Record<string, unknown> },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const edge = validateMetaEdge(payload.edge);
    const fields = structuredClone(payload.fields);
    const coercions: string[] = [];
    if (guard.forcePausedCreation && /^(campaigns|adsets|ads)$/.test(edge) && fields.status !== 'PAUSED') {
      fields.status = 'PAUSED';
      coercions.push('status coerced to PAUSED by policy (paused_creation)');
    }
    const budgetDeltas = collectMetaCreateBudgets(fields);
    return {
      summary: `Create Meta ${edge} resource`,
      changes: [`+ act_${act}/${edge} ${JSON.stringify(fields)}`],
      coercions,
      budgetDeltas,
      serverValidated: false,
      execute: async (validateOnly) => {
        const result = await this.client.post<{ id?: string }>(
          `act_${act}/${edge}`,
          this.withExecutionOptions(fields, validateOnly),
        );
        return result.id ? [result.id] : [];
      },
    };
  }

  private async planApiUpdate(
    act: string,
    payload: { object_id: string; fields: Record<string, unknown> },
  ): Promise<WritePlan> {
    if (containsMetaBudget(payload.fields)) {
      throw new AdportError('INVALID_INPUT', 'meta: budget updates require a typed budget tool for policy checks');
    }
    await this.assertObjectOwnedByAccount(payload.object_id, act);
    return {
      summary: `Update Meta object ${payload.object_id}`,
      changes: [`~ ${payload.object_id} ${JSON.stringify(payload.fields)}`],
      coercions: [],
      budgetDeltas: [],
      serverValidated: false,
      execute: async (validateOnly) => {
        await this.client.post(payload.object_id, this.withExecutionOptions(payload.fields, validateOnly));
        return [payload.object_id];
      },
    };
  }

  private async planApiDelete(act: string, payload: { object_id: string }): Promise<WritePlan> {
    await this.assertObjectOwnedByAccount(payload.object_id, act);
    return {
      summary: `Permanently delete Meta object ${payload.object_id}`,
      changes: [`- ${payload.object_id}`],
      coercions: [],
      budgetDeltas: [],
      serverValidated: false,
      execute: async (validateOnly) => {
        await this.client.delete(payload.object_id, this.withExecutionOptions({}, validateOnly));
        return [payload.object_id];
      },
    };
  }

  private async assertObjectOwnedByAccount(objectId: string, act: string): Promise<void> {
    if (!/^\d+$/.test(objectId)) throw new AdportError('INVALID_INPUT', 'meta: object_id must be numeric');
    const object = await this.client.get<{ account_id?: string }>(objectId, { fields: 'account_id' });
    if (normalizeAccountId(object.account_id ?? '') !== act) {
      throw new AdportError('INVALID_INPUT', `meta: object ${objectId} does not belong to ad account ${act}`);
    }
  }

  private withExecutionOptions(fields: Record<string, unknown>, validateOnly: boolean): Record<string, unknown> {
    return validateOnly ? { ...fields, execution_options: ['validate_only'] } : fields;
  }

  private async planCreateCampaign(
    act: string,
    payload: {
      name: string;
      objective: string;
      status?: string;
      special_ad_categories?: string[];
      daily_budget_cents?: number;
      is_adset_budget_sharing_enabled?: boolean;
    },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const coercions: string[] = [];
    let status = payload.status ?? 'ACTIVE';
    if (guard.forcePausedCreation && status === 'ACTIVE') {
      status = 'PAUSED';
      coercions.push('status coerced to PAUSED by policy (paused_creation)');
    }
    const fields: Record<string, unknown> = {
      name: payload.name,
      objective: payload.objective,
      status,
      // Required by the API even when empty.
      special_ad_categories: payload.special_ad_categories ?? [],
    };
    const budgetDeltas: WritePreview['budgetDeltas'] = [];
    const changes = [`+ campaign "${payload.name}" objective=${payload.objective} status=${status}`];
    if (payload.daily_budget_cents) {
      fields.daily_budget = payload.daily_budget_cents;
      changes.push(`+ campaign-level (Advantage/CBO) daily budget ${payload.daily_budget_cents} minor units`);
      budgetDeltas.push({
        target: `new campaign "${payload.name}" daily budget`,
        toMicros: payload.daily_budget_cents * CENTS_TO_MICROS,
      });
    } else {
      // Required by Marketing API v25 when the campaign does not own a budget.
      // false keeps every ad set's budget isolated; true permits Meta to share
      // up to 20% between eligible ad sets in this campaign.
      fields.is_adset_budget_sharing_enabled = payload.is_adset_budget_sharing_enabled ?? false;
      changes.push(
        `+ ad set budget sharing ${fields.is_adset_budget_sharing_enabled ? 'enabled' : 'disabled'}`,
      );
    }
    return {
      summary: `Create Meta campaign "${payload.name}" (${payload.objective}, ${status})`,
      changes,
      coercions,
      budgetDeltas,
      execute: async (validateOnly) => {
        const res = await this.client.post<{ id?: string; success?: boolean }>(
          `act_${act}/campaigns`,
          this.withExecutionOptions(fields, validateOnly),
        );
        return res.id ? [res.id] : [];
      },
    };
  }

  private async planSetStatus(
    payload: { object_id?: string; campaign_id?: string; ad_set_id?: string; status: 'ACTIVE' | 'PAUSED' },
    kind: string,
  ): Promise<WritePlan> {
    const objectId = payload.campaign_id ?? payload.ad_set_id ?? payload.object_id;
    if (!objectId) throw new AdportError('INVALID_INPUT', `meta: missing id for ${kind} status change`);
    const current = await this.client.get<{ name?: string; status?: string }>(objectId, {
      fields: 'name,status',
    });
    return {
      summary: `Set ${kind} "${current.name ?? objectId}" status ${current.status ?? '?'} → ${payload.status}`,
      changes: [`~ ${kind} ${objectId} status ${current.status ?? '?'} → ${payload.status}`],
      coercions: [],
      budgetDeltas: [],
      execute: async (validateOnly) => {
        await this.client.post<{ success?: boolean }>(
          objectId,
          this.withExecutionOptions({ status: payload.status }, validateOnly),
        );
        return [objectId];
      },
    };
  }

  /** Works for both campaigns (CBO) and ad sets — daily_budget lives on either. */
  private async planSetBudget(payload: { object_id: string; daily_budget_cents: number }): Promise<WritePlan> {
    const current = await this.client.get<{ name?: string; daily_budget?: string }>(payload.object_id, {
      fields: 'name,daily_budget',
    });
    const fromCents = current.daily_budget !== undefined ? Number(current.daily_budget) : undefined;
    if (fromCents === undefined) {
      throw new AdportError(
        'PROVIDER_ERROR',
        `meta: object ${payload.object_id} ("${current.name ?? '?'}") has no daily_budget — ` +
          'the budget may live on the other level (campaign vs ad set) or be a lifetime budget.',
      );
    }
    return {
      summary: `Change "${current.name ?? payload.object_id}" daily budget ${fromCents} → ${payload.daily_budget_cents} minor units`,
      changes: [`~ ${payload.object_id} daily_budget ${fromCents} → ${payload.daily_budget_cents}`],
      coercions: [],
      budgetDeltas: [
        {
          target: `"${current.name ?? payload.object_id}" daily budget`,
          fromMicros: fromCents * CENTS_TO_MICROS,
          toMicros: payload.daily_budget_cents * CENTS_TO_MICROS,
        },
      ],
      execute: async (validateOnly) => {
        await this.client.post<{ success?: boolean }>(
          payload.object_id,
          this.withExecutionOptions({ daily_budget: payload.daily_budget_cents }, validateOnly),
        );
        return [payload.object_id];
      },
    };
  }

  private async planCreateAdSet(
    act: string,
    payload: {
      campaign_id: string;
      name: string;
      daily_budget_cents?: number;
      optimization_goal?: string;
      billing_event?: string;
      countries: string[];
      status?: string;
    },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const coercions: string[] = [];
    let status = payload.status ?? 'ACTIVE';
    if (guard.forcePausedCreation && status === 'ACTIVE') {
      status = 'PAUSED';
      coercions.push('status coerced to PAUSED by policy (paused_creation)');
    }
    const fields: Record<string, unknown> = {
      name: payload.name,
      campaign_id: payload.campaign_id,
      optimization_goal: payload.optimization_goal ?? 'LINK_CLICKS',
      billing_event: payload.billing_event ?? 'IMPRESSIONS',
      targeting: { geo_locations: { countries: payload.countries } },
      status,
    };
    const budgetDeltas: WritePreview['budgetDeltas'] = [];
    if (payload.daily_budget_cents) {
      fields.daily_budget = payload.daily_budget_cents;
      budgetDeltas.push({
        target: `new ad set "${payload.name}" daily budget`,
        toMicros: payload.daily_budget_cents * CENTS_TO_MICROS,
      });
    }
    return {
      summary: `Create ad set "${payload.name}" in campaign ${payload.campaign_id} (${status})`,
      changes: [
        `+ ad_set "${payload.name}" targeting countries=[${payload.countries.join(', ')}] ` +
          `goal=${fields.optimization_goal} billing=${fields.billing_event} status=${status}` +
          (payload.daily_budget_cents ? ` daily_budget=${payload.daily_budget_cents}` : ' (budget on campaign/CBO)'),
      ],
      coercions,
      budgetDeltas,
      execute: async (validateOnly) => {
        const res = await this.client.post<{ id?: string; success?: boolean }>(
          `act_${act}/adsets`,
          this.withExecutionOptions(fields, validateOnly),
        );
        return res.id ? [res.id] : [];
      },
    };
  }
}

function actionValue(stats: ActionStat[] | undefined, actionType: string): number {
  const stat = stats?.find((s) => s.action_type === actionType);
  return stat ? Number(stat.value) : 0;
}

function validateMetaEdge(edge: string): string {
  const normalized = edge.replace(/^\/+|\/+$/g, '').trim();
  if (!/^[a-z][a-z0-9_]{1,80}(?:\/[a-z0-9_]+)*$/.test(normalized) || normalized.includes('..')) {
    throw new AdportError('INVALID_INPUT', `meta: invalid ad-account edge "${edge}"`);
  }
  return normalized;
}

function collectMetaCreateBudgets(fields: Record<string, unknown>): WritePreview['budgetDeltas'] {
  const deltas: WritePreview['budgetDeltas'] = [];
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}[${index}]`));
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      if (/budget/i.test(key)) {
        const cents = Number(child);
        if (Number.isFinite(cents) && cents > 0) {
          deltas.push({ target: childPath, toMicros: Math.round(cents * CENTS_TO_MICROS) });
        }
      }
      visit(child, childPath);
    }
  };
  visit(fields, 'fields');
  return deltas;
}

function containsMetaBudget(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsMetaBudget);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([key, child]) => /budget/i.test(key) || containsMetaBudget(child));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
