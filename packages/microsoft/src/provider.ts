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
import { unzipSync } from 'fflate';
import { formatPartialErrors, MicrosoftAdsClient, type MicrosoftService } from './client.js';
import { parseCsv } from './csv.js';

/** DailyBudget is a double in whole account-currency units. */
export const UNITS_TO_MICROS = 1_000_000;

interface MicrosoftCampaign {
  Id: number | string;
  Name: string;
  Status: string;
  DailyBudget?: number;
  BudgetType?: string;
  BudgetId?: number | string | null;
  TimeZone?: string;
  CampaignType?: string;
}

interface WritePlan {
  summary: string;
  changes: string[];
  coercions: string[];
  budgetDeltas: WritePreview['budgetDeltas'];
  execute: () => Promise<string[]>;
}

export class MicrosoftAdsProvider implements AdProvider {
  readonly id = 'microsoft';
  /** accountId → parent customer id, learned from SearchAccounts. */
  private customerIds = new Map<string, string>();

  constructor(
    private readonly client: MicrosoftAdsClient,
    private readonly options: { pollIntervalMs?: number; pollMaxAttempts?: number } = {},
  ) {}

  capabilities(): ProviderCapabilities {
    return { serverDryRun: false };
  }

  standardActions(): StandardActions {
    return {
      pauseCampaign: (accountId, campaignId) => ({
        tool: 'microsoft_set_campaign_status',
        input: { account_id: accountId, campaign_id: campaignId, status: 'Paused' },
      }),
    };
  }

  async listAccounts(): Promise<Account[]> {
    const user = await this.client.request<{ User?: { Id?: number | string } }>(
      'customer',
      'POST',
      'User/Query',
      { UserId: null },
    );
    const userId = user.User?.Id;
    if (userId === undefined) {
      throw new AdportError('PROVIDER_ERROR', 'microsoft: GetUser returned no user id');
    }
    const search = await this.client.request<{
      Accounts?: Array<{
        Id: number | string;
        Name?: string;
        Number?: string;
        CurrencyCode?: string;
        AccountLifeCycleStatus?: string;
        ParentCustomerId?: number | string;
      }>;
    }>('customer', 'POST', 'Accounts/Search', {
      Predicates: [{ Field: 'UserId', Operator: 'Equals', Value: String(userId) }],
      PageInfo: { Index: 0, Size: 100 },
    });
    const accounts = search.Accounts ?? [];
    for (const account of accounts) {
      if (account.ParentCustomerId !== undefined) {
        this.customerIds.set(String(account.Id), String(account.ParentCustomerId));
      }
    }
    return accounts.map((a) => ({
      provider: this.id,
      id: String(a.Id),
      name: a.Name ?? a.Number ?? String(a.Id),
      currency: a.CurrencyCode,
      status: a.AccountLifeCycleStatus,
    }));
  }

  private async scopeFor(accountId: string) {
    if (!this.customerIds.has(accountId)) await this.listAccounts();
    return { customerId: this.customerIds.get(accountId), customerAccountId: accountId };
  }

  async listCampaigns(accountId: string): Promise<MicrosoftCampaign[]> {
    const scope = await this.scopeFor(accountId);
    const data = await this.client.request<{ Campaigns?: MicrosoftCampaign[] | null }>(
      'campaign',
      'POST',
      'Campaigns/QueryByAccountId',
      { AccountId: accountId, ReturnAdditionalFields: null },
      scope,
    );
    return data.Campaigns ?? [];
  }

  async apiRead(input: {
    account_id: string;
    service: MicrosoftService;
    path: string;
    body?: Record<string, unknown>;
  }): Promise<unknown> {
    const path = validateMicrosoftReadPath(input.path);
    validateMicrosoftAccountScope(input.body, input.account_id);
    const scope = await this.scopeFor(input.account_id);
    return this.client.request(input.service, 'POST', path, input.body ?? {}, scope);
  }

  async report(query: NormalizedQuery): Promise<Report> {
    if (query.level !== 'campaign' && query.level !== 'account') {
      throw new AdportError('INVALID_INPUT', 'microsoft: report supports campaign and account levels in v0');
    }
    const range = resolveDateRange(query.dateRange);
    const accountIds = query.accountIds ?? (await this.listAccounts()).map((a) => a.id);
    const rows: ReportRow[] = [];
    for (const accountId of accountIds) {
      const providerRows = await this.campaignReport(accountId, range.start, range.end, query);
      if (query.level === 'account') {
        if (providerRows.length > 0) rows.push(aggregateAccountRows(providerRows, this.id, accountId));
      } else {
        rows.push(...providerRows);
      }
    }
    return { rows };
  }

  private async campaignReport(
    accountId: string,
    start: string,
    end: string,
    query: NormalizedQuery,
  ): Promise<ReportRow[]> {
    const scope = await this.scopeFor(accountId);
    const toDate = (iso: string) => {
      const [year, month, day] = iso.split('-').map(Number);
      return { Day: day, Month: month, Year: year };
    };
    // Async flow: Submit → Poll until Success → download zipped CSV.
    const submit = await this.client.request<{ ReportRequestId?: string }>(
      'reporting',
      'POST',
      'GenerateReport/Submit',
      {
        ReportRequest: {
          Type: 'CampaignPerformanceReportRequest',
          Format: 'Csv',
          FormatVersion: '2.0',
          ReportName: 'adport campaign report',
          ExcludeReportHeader: true,
          ExcludeReportFooter: true,
          ExcludeColumnHeaders: false,
          ReturnOnlyCompleteData: false,
          Aggregation: 'Summary',
          Columns: ['CampaignId', 'CampaignName', 'CampaignStatus', 'Spend', 'Impressions', 'Clicks', 'Conversions', 'Revenue'],
          Scope: { AccountIds: [accountId] },
          Time: { CustomDateRangeStart: toDate(start), CustomDateRangeEnd: toDate(end) },
        },
      },
      scope,
    );
    if (!submit.ReportRequestId) {
      throw new AdportError('PROVIDER_ERROR', 'microsoft: SubmitGenerateReport returned no ReportRequestId');
    }

    const maxAttempts = this.options.pollMaxAttempts ?? 30;
    const interval = this.options.pollIntervalMs ?? 5_000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const poll = await this.client.request<{
        ReportRequestStatus?: { Status?: string; ReportDownloadUrl?: string | null };
      }>('reporting', 'POST', 'GenerateReport/Poll', { ReportRequestId: submit.ReportRequestId }, scope);
      const status = poll.ReportRequestStatus?.Status;
      if (status === 'Error') {
        throw new AdportError('PROVIDER_ERROR', 'microsoft: report generation failed (Status: Error)');
      }
      if (status === 'Success') {
        const url = poll.ReportRequestStatus?.ReportDownloadUrl;
        if (!url) return []; // Success with null URL = no data for the range.
        return this.parseReport(await this.client.download(url), accountId, query);
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new AdportError('PROVIDER_ERROR', `microsoft: report not ready after ${maxAttempts} polls`);
  }

  private parseReport(zipBytes: Uint8Array, accountId: string, query: NormalizedQuery): ReportRow[] {
    const files = unzipSync(zipBytes);
    const first = Object.values(files)[0];
    if (!first) return [];
    const rows = parseCsv(new TextDecoder().decode(first));
    if (rows.length < 2) return [];
    const header = rows[0]!;
    const index = (name: string) => header.indexOf(name);
    const out: ReportRow[] = [];
    for (const row of rows.slice(1)) {
      const value = (name: string) => {
        const i = index(name);
        return i >= 0 ? (row[i] ?? '') : '';
      };
      const spend = Number(value('Spend') || 0);
      const impressions = Number(value('Impressions') || 0);
      const clicks = Number(value('Clicks') || 0);
      const conversions = Number(value('Conversions') || 0);
      const revenue = Number(value('Revenue') || 0);
      const all: Record<MetricName, number> = {
        spend: round2(spend),
        impressions,
        clicks,
        conversions,
        conversion_value: round2(revenue),
        ctr: impressions > 0 ? round2((clicks / impressions) * 100) : 0,
        cpc: clicks > 0 ? round2(spend / clicks) : 0,
        cpm: impressions > 0 ? round2((spend / impressions) * 1000) : 0,
        cpa: conversions > 0 ? round2(spend / conversions) : 0,
        roas: spend > 0 ? round2(revenue / spend) : 0,
      };
      out.push({
        provider: this.id,
        accountId,
        entity: {
          level: 'campaign',
          id: value('CampaignId'),
          name: value('CampaignName'),
          status: value('CampaignStatus') || undefined,
        },
        metrics: Object.fromEntries(query.metrics.map((m) => [m, all[m]])),
      });
    }
    return out;
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
      case 'microsoft_create_campaign':
        return this.planCreateCampaign(op.accountId, payload, guard);
      case 'microsoft_set_campaign_status':
        return this.planSetStatus(op.accountId, payload);
      case 'microsoft_set_budget':
        return this.planSetBudget(op.accountId, payload);
      case 'microsoft_api_create':
        return this.planApiCreate(op.accountId, payload, guard);
      case 'microsoft_api_update':
        return this.planApiUpdate(op.accountId, payload);
      case 'microsoft_api_delete':
        return this.planApiDelete(op.accountId, payload);
      default:
        throw new AdportError('PROVIDER_ERROR', `microsoft: unsupported write tool ${op.tool}`);
    }
  }

  private async planApiCreate(
    accountId: string,
    payload: { resource: string; body: Record<string, unknown> },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const resource = validateMicrosoftResource(payload.resource);
    const body = structuredClone(payload.body);
    validateMicrosoftAccountScope(body, accountId);
    const coercions: string[] = [];
    if (guard.forcePausedCreation) coerceMicrosoftCreatedStatuses(body, coercions);
    return {
      summary: `Create Microsoft Advertising ${resource} resource(s)`,
      changes: [`+ POST /${resource} ${JSON.stringify(body)}`],
      coercions,
      budgetDeltas: collectMicrosoftBudgets(body),
      execute: async () => this.executeMicrosoftMutation(accountId, 'POST', resource, body),
    };
  }

  private async planApiUpdate(
    accountId: string,
    payload: { resource: string; body: Record<string, unknown> },
  ): Promise<WritePlan> {
    const resource = validateMicrosoftResource(payload.resource);
    validateMicrosoftAccountScope(payload.body, accountId);
    if (containsMicrosoftBudget(payload.body)) {
      throw new AdportError('INVALID_INPUT', 'microsoft: budget updates require microsoft_set_budget for policy checks');
    }
    return {
      summary: `Update Microsoft Advertising ${resource} resource(s)`,
      changes: [`~ PUT /${resource} ${JSON.stringify(payload.body)}`],
      coercions: [],
      budgetDeltas: [],
      execute: async () => this.executeMicrosoftMutation(accountId, 'PUT', resource, payload.body),
    };
  }

  private async planApiDelete(
    accountId: string,
    payload: { resource: string; body: Record<string, unknown> },
  ): Promise<WritePlan> {
    const resource = validateMicrosoftResource(payload.resource);
    validateMicrosoftAccountScope(payload.body, accountId);
    return {
      summary: `Permanently delete Microsoft Advertising ${resource} resource(s)`,
      changes: [`- DELETE /${resource} ${JSON.stringify(payload.body)}`],
      coercions: [],
      budgetDeltas: [],
      execute: async () => this.executeMicrosoftMutation(accountId, 'DELETE', resource, payload.body),
    };
  }

  private async executeMicrosoftMutation(
    accountId: string,
    method: 'POST' | 'PUT' | 'DELETE',
    resource: string,
    body: Record<string, unknown>,
  ): Promise<string[]> {
    const scope = await this.scopeFor(accountId);
    const result = await this.client.request<Record<string, unknown>>('campaign', method, resource, body, scope);
    const partial = formatPartialErrors(result.PartialErrors as Parameters<typeof formatPartialErrors>[0]);
    if (partial) throw new AdportError('PROVIDER_ERROR', `microsoft: ${resource} partial errors — ${partial}`);
    return extractMicrosoftIds(result);
  }

  private async planCreateCampaign(
    accountId: string,
    payload: { name: string; daily_budget: number; time_zone?: string; status?: string },
    guard: WriteGuard,
  ): Promise<WritePlan> {
    const coercions: string[] = [];
    // The API's own default status on Add is Paused; we only coerce an explicit Active.
    let status = payload.status ?? 'Paused';
    if (guard.forcePausedCreation && status === 'Active') {
      status = 'Paused';
      coercions.push('status coerced to Paused by policy (paused_creation)');
    }
    const campaign = {
      Name: payload.name,
      CampaignType: 'Search',
      DailyBudget: payload.daily_budget,
      BudgetType: 'DailyBudgetStandard',
      TimeZone: payload.time_zone ?? 'PacificTimeUSCanadaTijuana',
      Status: status,
    };
    return {
      summary: `Create Microsoft Advertising campaign "${payload.name}" (${status}), daily budget ${payload.daily_budget}`,
      changes: [`+ campaign "${payload.name}" type=Search daily_budget=${payload.daily_budget} status=${status}`],
      coercions,
      budgetDeltas: [
        { target: `new campaign "${payload.name}" daily budget`, toMicros: payload.daily_budget * UNITS_TO_MICROS },
      ],
      execute: async () => {
        const scope = await this.scopeFor(accountId);
        const result = await this.client.request<{
          CampaignIds?: Array<number | string | null>;
          PartialErrors?: Array<{ Index?: number; Code?: number; ErrorCode?: string; Message?: string; FieldPath?: string }>;
        }>('campaign', 'POST', 'Campaigns', { AccountId: accountId, Campaigns: [campaign] }, scope);
        const partial = formatPartialErrors(result.PartialErrors);
        if (partial) throw new AdportError('PROVIDER_ERROR', `microsoft: AddCampaigns partial errors — ${partial}`);
        return (result.CampaignIds ?? []).filter((id): id is number | string => id !== null).map(String);
      },
    };
  }

  private async lookupCampaign(accountId: string, campaignId: string): Promise<MicrosoftCampaign> {
    const campaigns = await this.listCampaigns(accountId);
    const campaign = campaigns.find((c) => String(c.Id) === campaignId);
    if (!campaign) {
      throw new AdportError('PROVIDER_ERROR', `microsoft: campaign ${campaignId} not found in account ${accountId}`);
    }
    return campaign;
  }

  private async updateCampaign(
    accountId: string,
    fields: Record<string, unknown> & { Id: number | string },
  ): Promise<void> {
    const scope = await this.scopeFor(accountId);
    // UpdateCampaigns is PUT; omitted fields stay unchanged.
    const result = await this.client.request<{
      PartialErrors?: Array<{ Index?: number; Code?: number; ErrorCode?: string; Message?: string }>;
    }>('campaign', 'PUT', 'Campaigns', { AccountId: accountId, Campaigns: [fields] }, scope);
    const partial = formatPartialErrors(result.PartialErrors);
    if (partial) throw new AdportError('PROVIDER_ERROR', `microsoft: UpdateCampaigns partial errors — ${partial}`);
  }

  private async planSetStatus(
    accountId: string,
    payload: { campaign_id: string; status: 'Active' | 'Paused' },
  ): Promise<WritePlan> {
    const current = await this.lookupCampaign(accountId, payload.campaign_id);
    return {
      summary: `Set Microsoft campaign "${current.Name}" status ${current.Status} → ${payload.status}`,
      changes: [`~ campaign ${payload.campaign_id} Status ${current.Status} → ${payload.status}`],
      coercions: [],
      budgetDeltas: [],
      execute: async () => {
        await this.updateCampaign(accountId, { Id: current.Id, Status: payload.status });
        return [payload.campaign_id];
      },
    };
  }

  private async planSetBudget(
    accountId: string,
    payload: { campaign_id: string; daily_budget: number },
  ): Promise<WritePlan> {
    const current = await this.lookupCampaign(accountId, payload.campaign_id);
    if (current.BudgetId && Number(current.BudgetId) > 0) {
      throw new AdportError(
        'PROVIDER_ERROR',
        `microsoft: campaign "${current.Name}" uses a SHARED budget (BudgetId ${current.BudgetId}) — ` +
          'its DailyBudget cannot be changed per-campaign (CampaignServiceCannotUpdateSharedBudget).',
      );
    }
    return {
      summary: `Change Microsoft campaign "${current.Name}" daily budget ${current.DailyBudget ?? '(unset)'} → ${payload.daily_budget}`,
      changes: [`~ campaign ${payload.campaign_id} DailyBudget ${current.DailyBudget ?? '(unset)'} → ${payload.daily_budget}`],
      coercions: [],
      budgetDeltas: [
        {
          target: `campaign "${current.Name}" daily budget`,
          ...(current.DailyBudget !== undefined ? { fromMicros: current.DailyBudget * UNITS_TO_MICROS } : {}),
          toMicros: payload.daily_budget * UNITS_TO_MICROS,
        },
      ],
      execute: async () => {
        await this.updateCampaign(accountId, { Id: current.Id, DailyBudget: payload.daily_budget });
        return [payload.campaign_id];
      },
    };
  }
}

function aggregateAccountRows(rows: ReportRow[], provider: string, accountId: string): ReportRow {
  const metrics = Object.fromEntries(
    Object.keys(rows[0]!.metrics).map((metric) => [
      metric,
      round2(rows.reduce((sum, row) => sum + (row.metrics[metric as MetricName] ?? 0), 0)),
    ]),
  ) as Partial<Record<MetricName, number>>;
  const spend = metrics.spend ?? 0;
  const impressions = metrics.impressions ?? 0;
  const clicks = metrics.clicks ?? 0;
  const conversions = metrics.conversions ?? 0;
  const conversionValue = metrics.conversion_value ?? 0;
  if ('ctr' in metrics) metrics.ctr = impressions > 0 ? round2((clicks / impressions) * 100) : 0;
  if ('cpc' in metrics) metrics.cpc = clicks > 0 ? round2(spend / clicks) : 0;
  if ('cpm' in metrics) metrics.cpm = impressions > 0 ? round2((spend / impressions) * 1000) : 0;
  if ('cpa' in metrics) metrics.cpa = conversions > 0 ? round2(spend / conversions) : 0;
  if ('roas' in metrics) metrics.roas = spend > 0 ? round2(conversionValue / spend) : 0;
  return { provider, accountId, entity: { level: 'account', id: accountId, name: accountId }, metrics };
}

function validateMicrosoftReadPath(path: string): string {
  const normalized = path.replace(/^\/+|\/+$/g, '').trim();
  const action = normalized.split('/').at(-1) ?? '';
  if (
    !/^[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z][A-Za-z0-9]*){1,2}$/.test(normalized) ||
    !/^(?:Query|Search|Get|Submit|Poll)/.test(action)
  ) {
    throw new AdportError('INVALID_INPUT', `microsoft: unsupported read operation path "${path}"`);
  }
  return normalized;
}

function validateMicrosoftResource(resource: string): string {
  const normalized = resource.trim();
  if (!/^[A-Z][A-Za-z0-9]{1,80}$/.test(normalized)) {
    throw new AdportError('INVALID_INPUT', `microsoft: invalid Campaign Management resource "${resource}"`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateMicrosoftAccountScope(value: unknown, accountId: string): void {
  if (Array.isArray(value)) return value.forEach((item) => validateMicrosoftAccountScope(item, accountId));
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'AccountId' && String(child) !== accountId) {
      throw new AdportError('INVALID_INPUT', `microsoft: body AccountId ${String(child)} does not match selected account ${accountId}`);
    }
    if (key === 'AccountIds' && Array.isArray(child) && child.some((id) => String(id) !== accountId)) {
      throw new AdportError('INVALID_INPUT', `microsoft: body AccountIds must contain only selected account ${accountId}`);
    }
    validateMicrosoftAccountScope(child, accountId);
  }
}

function coerceMicrosoftCreatedStatuses(value: unknown, coercions: string[], path = 'body'): void {
  if (Array.isArray(value)) return value.forEach((item, index) => coerceMicrosoftCreatedStatuses(item, coercions, `${path}[${index}]`));
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'Status' && child === 'Active') {
      value[key] = 'Paused';
      coercions.push(`${path}.${key} coerced to Paused by policy (paused_creation)`);
    } else coerceMicrosoftCreatedStatuses(child, coercions, `${path}.${key}`);
  }
}

function containsMicrosoftBudget(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsMicrosoftBudget);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => /budget/i.test(key) || containsMicrosoftBudget(child));
}

function collectMicrosoftBudgets(value: unknown, path = 'body'): WritePreview['budgetDeltas'] {
  const deltas: WritePreview['budgetDeltas'] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => deltas.push(...collectMicrosoftBudgets(item, `${path}[${index}]`)));
    return deltas;
  }
  if (!isRecord(value)) return deltas;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (/budget/i.test(key) && !/type|id/i.test(key)) {
      const amount = Number(child);
      if (Number.isFinite(amount) && amount > 0) {
        deltas.push({ target: childPath, toMicros: Math.round(amount * UNITS_TO_MICROS) });
      }
    }
    deltas.push(...collectMicrosoftBudgets(child, childPath));
  }
  return deltas;
}

function extractMicrosoftIds(value: unknown): string[] {
  const ids: string[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!isRecord(item)) return;
    for (const [key, child] of Object.entries(item)) {
      if (/Ids?$/.test(key)) {
        if (Array.isArray(child)) child.forEach((id) => { if (id !== null) ids.push(String(id)); });
        else if (typeof child === 'string' || typeof child === 'number') ids.push(String(child));
      } else visit(child);
    }
  };
  visit(value);
  return [...new Set(ids)];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
