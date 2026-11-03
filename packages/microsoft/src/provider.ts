import {
  AdportError,
  LocalMediaResolver,
  METRICS,
  resolveDateRange,
  type Account,
  type AdProvider,
  type MetricName,
  type MediaResolver,
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
import { MicrosoftChildService } from './children.js';
import { MicrosoftImageService, MICROSOFT_IMAGE_WRITES } from './images.js';

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
  readonly children: MicrosoftChildService;
  readonly images: MicrosoftImageService;

  constructor(
    private readonly client: MicrosoftAdsClient,
    private readonly options: { pollIntervalMs?: number; pollMaxAttempts?: number } = {},
    media: MediaResolver = new LocalMediaResolver(),
  ) {
    this.children = new MicrosoftChildService(client, account => this.scopeFor(account), (account, campaign) => this.lookupCampaign(account, campaign));
    this.images = new MicrosoftImageService(client, account => this.scopeFor(account), media);
  }

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
    const range = resolveDateRange(query.dateRange);
    const accountIds = query.accountIds ?? (await this.listAccounts()).map((a) => a.id);
    const rows: ReportRow[] = [];
    for (const accountId of accountIds) {
      const providerRows = await this.performanceReport(accountId, range.start, range.end, query.level === 'account' ? { ...query, level: 'campaign', metrics: [...METRICS] } : query);
      if (query.level === 'account') {
        if (providerRows.length > 0) {
          const aggregate = aggregateAccountRows(providerRows, this.id, accountId);
          aggregate.metrics = Object.fromEntries(query.metrics.filter(metric => aggregate.metrics[metric] !== undefined).map(metric => [metric, aggregate.metrics[metric]]));
          rows.push(aggregate);
        }
      } else {
        rows.push(...providerRows);
      }
    }
    const limit = query.limit ?? 1000;
    return { rows: rows.slice(0, limit), truncated: rows.length > limit };
  }

  private async performanceReport(accountId: string, start: string, end: string, query: NormalizedQuery): Promise<ReportRow[]> {
    const selection = query.level === 'ad_group'
      ? { type: 'AdGroupPerformanceReportRequest', columns: ['AdGroupId', 'AdGroupName', 'Status'] }
      : query.level === 'ad' ? { type: 'AdPerformanceReportRequest', columns: ['AdId', 'AdTitle', 'AdStatus'] }
        : { type: 'CampaignPerformanceReportRequest', columns: ['CampaignId', 'CampaignName', 'CampaignStatus'] };
    const bytes = await this.reportCsv(accountId, start, end, selection.type, [...selection.columns, 'Spend', 'Impressions', 'Clicks', 'Conversions', 'Revenue']);
    return bytes ? this.parseReport(bytes, accountId, query) : [];
  }

  async nativeReport(input: { account_id: string; kind: 'keyword' | 'search_term'; date_range: NormalizedQuery['dateRange']; limit: number }) {
    const range = resolveDateRange(input.date_range);
    const type = input.kind === 'keyword' ? 'KeywordPerformanceReportRequest' : 'SearchQueryPerformanceReportRequest';
    const columns = input.kind === 'keyword' ? ['CampaignId', 'AdGroupId', 'KeywordId', 'Keyword', 'BidMatchType'] : ['CampaignId', 'AdGroupId', 'AdId', 'KeywordId', 'Keyword', 'SearchQuery'];
    const bytes = await this.reportCsv(input.account_id, range.start, range.end, type, [...columns, 'Spend', 'Impressions', 'Clicks', 'Conversions', 'Revenue']);
    const records = bytes ? this.reportObjects(bytes) : [];
    return { rows: records.slice(0, input.limit), truncated: records.length > input.limit, report_type: type };
  }

  private async reportCsv(
    accountId: string,
    start: string,
    end: string,
    type: string,
    columns: string[],
  ): Promise<Uint8Array | undefined> {
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
          Type: type,
          Format: 'Csv',
          FormatVersion: '2.0',
          ReportName: 'adport campaign report',
          ExcludeReportHeader: true,
          ExcludeReportFooter: true,
          ExcludeColumnHeaders: false,
          ReturnOnlyCompleteData: false,
          Aggregation: 'Summary',
          Columns: columns,
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
        if (!url) return undefined; // Success with null URL = no data for the range.
        return this.client.download(url);
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new AdportError('PROVIDER_ERROR', `microsoft: report not ready after ${maxAttempts} polls`);
  }

  private reportObjects(zipBytes: Uint8Array): Array<Record<string, string>> {
    const files = unzipSync(zipBytes);
    const selected = Object.entries(files).find(([name]) => name.toLowerCase().endsWith('.csv'))?.[1] ?? Object.values(files)[0];
    if (!selected) return [];
    const rows = parseCsv(new TextDecoder().decode(selected).replace(/^\uFEFF/, ''));
    const header = rows[0];
    return header ? rows.slice(1).map(row => Object.fromEntries(header.map((key, index) => [key, row[index] ?? '']))) : [];
  }

  private parseReport(zipBytes: Uint8Array, accountId: string, query: NormalizedQuery): ReportRow[] {
    return this.reportObjects(zipBytes).map(row => {
      const numeric = (key: string) => {
        const text = row[key]?.trim();
        if (!text) return undefined;
        const number = Number(text);
        return Number.isFinite(number) ? number : undefined;
      };
      const metrics = performanceMetrics({ spend: numeric('Spend'), impressions: numeric('Impressions'), clicks: numeric('Clicks'), conversions: numeric('Conversions'), conversion_value: numeric('Revenue') });
      const identity = query.level === 'ad_group' ? ['AdGroupId', 'AdGroupName', 'Status'] : query.level === 'ad' ? ['AdId', 'AdTitle', 'AdStatus'] : ['CampaignId', 'CampaignName', 'CampaignStatus'];
      return { provider: this.id, accountId, entity: { level: query.level, id: row[identity[0]!] ?? '', name: row[identity[1]!] ?? '', status: row[identity[2]!] || undefined },
        metrics: Object.fromEntries(query.metrics.filter(metric => metrics[metric] !== undefined).map(metric => [metric, metrics[metric]])) };
    });
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
    if (MICROSOFT_IMAGE_WRITES.has(op.tool)) return this.images.plan(op);
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
        return this.children.plan(op, guard);
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

function performanceMetrics(base: Partial<Record<MetricName, number>>): Partial<Record<MetricName, number>> {
  const ratio = (numerator: number | undefined, denominator: number | undefined, scale = 1) => numerator === undefined || denominator === undefined ? undefined : denominator > 0 ? round2(numerator / denominator * scale) : 0;
  return Object.fromEntries(Object.entries({ ...base,
    ctr: ratio(base.clicks, base.impressions, 100), cpc: ratio(base.spend, base.clicks), cpm: ratio(base.spend, base.impressions, 1000),
    cpa: ratio(base.spend, base.conversions), roas: ratio(base.conversion_value, base.spend),
  }).filter(([, value]) => value !== undefined).map(([key, value]) => [key, round2(value!)]));
}

function aggregateAccountRows(rows: ReportRow[], provider: string, accountId: string): ReportRow {
  const totals: Partial<Record<MetricName, number>> = {};
  for (const metric of ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value'] as const) {
    if (rows.every(row => row.metrics[metric] !== undefined)) totals[metric] = rows.reduce((sum, row) => sum + row.metrics[metric]!, 0);
  }
  return { provider, accountId, entity: { level: 'account', id: accountId, name: accountId }, metrics: performanceMetrics(totals) };
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
