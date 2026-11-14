import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteGuard, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { MicrosoftNativeService, microsoftId as id, microsoftNativeId as nativeId, microsoftRows as rows, type MicrosoftPlan, type MicrosoftRow as Row } from './native.js';
import type { MicrosoftAdsProvider } from './provider.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/), name = z.string().min(1).max(128).refine(value => value.trim().length > 0, 'Name cannot be blank');
const date = z.iso.date(), split = z.number().int().min(1).max(99);
const create = z.object({ base_campaign_id: id, expected_base_context_hash: hash, name, start_date: date, end_date: date.optional(), traffic_split_percent: split, experiment_type: z.enum(['TrafficBased', 'CookieBased']).default('TrafficBased') }).refine(value => !value.end_date || value.start_date <= value.end_date, 'End date must be on or after start date');
const reference = z.object({ experiment_id: id, expected_snapshot_hash: hash });
const update = reference.extend({ name: name.optional(), start_date: date.optional(), end_date: date.nullable().optional(), traffic_split_percent: split.optional() }).refine(value => ['name', 'start_date', 'end_date', 'traffic_split_percent'].some(key => value[key as keyof typeof value] !== undefined), 'Supply an editable experiment field');
const additional = 'ExperimentSubType, ExperimentArms, ExperimentCampaignType';
const notes = ['Microsoft copies eligible base-campaign settings and child entities into an experiment campaign. Expired ad groups, legacy ad formats and some legacy keyword/audience settings are not copied; native copy diagnostics can report omissions.', 'The experiment campaign inherits the base budget, BudgetType, status and timezone. TrafficSplitPercent divides the existing base budget/traffic; the branch is not an additional independent daily pool. Pause or change budget through the base campaign.', 'Dates are calendar dates in the base campaign timezone; end dates are inclusive. Setup is asynchronous. A returned experiment ID or Creating status does not prove the campaign copy is ready.', 'Snapshots cover the experiment and parent/branch campaign configuration plus the visible active experiment inventory, not every child entity. Microsoft provides no atomic compare-and-set; external changes can race submission.'];
const contextSchema = z.object({ account_id: id, base_campaign: z.record(z.string(), z.unknown()), active_experiments: z.array(z.record(z.string(), z.unknown())), currency: z.string().optional(), snapshot_hash: hash });
const viewSchema = z.object({ account_id: id, experiment: z.record(z.string(), z.unknown()), base_context: contextSchema, experiment_campaign: z.record(z.string(), z.unknown()).optional(), snapshot_hash: hash, notes: z.array(z.string()) });
type Context = z.infer<typeof contextSchema>;
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : value; }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const optionalId = (value: unknown) => value === null || value === undefined || value === '0' || value === 0 ? undefined : nativeId(value);
function nativeDate(value: string): Row { const [Year, Month, Day] = value.split('-').map(Number); return { Day, Month, Year }; }
function calendarDate(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const row = z.object({ Year: z.number().int(), Month: z.number().int(), Day: z.number().int() }).parse(value);
  if (row.Year === 0 && row.Month === 0 && row.Day === 0) return undefined;
  return date.parse(`${String(row.Year).padStart(4, '0')}-${String(row.Month).padStart(2, '0')}-${String(row.Day).padStart(2, '0')}`);
}
const micros = (value: unknown) => { if (typeof value !== 'number' || value <= 0 || !Number.isSafeInteger(Math.round(value * 1_000_000)) || Math.abs(value * 1_000_000 - Math.round(value * 1_000_000)) > 0.000001) throw new AdportError('PROVIDER_ERROR', 'microsoft: base campaign daily budget cannot be represented safely in micros'); return Math.round(value * 1_000_000); };
export const MICROSOFT_EXPERIMENT_WRITES = new Set(['microsoft_create_experiment', 'microsoft_update_experiment', 'microsoft_end_experiment', 'microsoft_delete_experiment']);

/** Native v13 experiments: Active is the required setup input, not an independently pausable branch status. */
export class MicrosoftExperimentService extends MicrosoftNativeService {
  constructor(...args: [...ConstructorParameters<typeof MicrosoftNativeService>, (account: string) => Promise<unknown>, (account: string) => Promise<string | undefined>]) {
    const [client, scope, campaign, campaigns, currency] = args; super(client, scope, campaign); this.campaigns = campaigns; this.currency = currency;
  }
  private readonly campaigns: (account: string) => Promise<unknown>;
  private readonly currency: (account: string) => Promise<string | undefined>;

  private async query(account: string, ids: string[] | null): Promise<Row[]> {
    const result = await this.request(account, 'Experiments/QueryByIds', { ExperimentIds: ids, ReturnAdditionalFields: additional });
    if (!Object.hasOwn(result, 'Experiments') || result.Experiments !== null && !Array.isArray(result.Experiments)) throw new AdportError('PROVIDER_ERROR', 'microsoft: experiment response envelope is missing or malformed');
    const values = rows((result.Experiments as unknown[] | null)?.filter(value => value !== null));
    if (new Set(values.map(value => nativeId(value.Id))).size !== values.length || values.some(value => ids && !ids.includes(nativeId(value.Id)))) throw new AdportError('PROVIDER_ERROR', 'microsoft: duplicate or unexpected experiment identities');
    return values;
  }

  private async campaignById(account: string, campaignId: string, type: unknown): Promise<Row | undefined> {
    const result = await this.request(account, 'Campaigns/QueryByIds', { AccountId: account, CampaignIds: [campaignId], CampaignType: type, ReturnAdditionalFields: 'TargetSetting' });
    if (!Object.hasOwn(result, 'Campaigns') || result.Campaigns !== null && !Array.isArray(result.Campaigns)) throw new AdportError('PROVIDER_ERROR', 'microsoft: experiment campaign response envelope is missing');
    const campaigns = rows((result.Campaigns as unknown[] | null)?.filter(value => value !== null));
    if (campaigns.length > 1 || campaigns.some(value => nativeId(value.Id) !== campaignId || value.CampaignType !== type)) throw new AdportError('PROVIDER_ERROR', 'microsoft: experiment campaign identity/type mismatch');
    return campaigns[0];
  }

  async base(account: string, campaignId: string, refresh = false): Promise<Context> {
    await this.accountScope(account, refresh);
    const known = await this.campaign(account, campaignId), base = await this.campaignById(account, campaignId, known.CampaignType);
    if (!base || typeof base.Name !== 'string' || typeof base.Status !== 'string' || typeof base.TimeZone !== 'string') throw new AdportError('PROVIDER_ERROR', 'microsoft: base campaign configuration is incomplete');
    const active = (await this.query(account, null)).filter(value => nativeId(value.BaseCampaignId) === campaignId).sort((a, b) => BigInt(nativeId(a.Id)) < BigInt(nativeId(b.Id)) ? -1 : 1), currency = await this.currency(account);
    const visible = { account_id: account, base_campaign: base, active_experiments: active, ...(currency ? { currency } : {}) };
    return { ...visible, snapshot_hash: digest(visible) };
  }

  async list(input: { account_id: string; after_experiment_id?: string; limit: number }) {
    const remaining = (await this.query(input.account_id, null)).filter(value => !input.after_experiment_id || BigInt(nativeId(value.Id)) > BigInt(input.after_experiment_id)).sort((a, b) => BigInt(nativeId(a.Id)) < BigInt(nativeId(b.Id)) ? -1 : 1), page = remaining.slice(0, input.limit), truncated = remaining.length > page.length;
    return { rows: page, truncated, ...(truncated ? { next_cursor: nativeId(page.at(-1)!.Id) } : {}), visibility: 'Native active inventory only; use microsoft_get_experiment for an exact known historical ID.', notes };
  }

  async get(account: string, experimentId: string, refresh = false) {
    await this.accountScope(account, refresh);
    const values = await this.query(account, [experimentId]), experiment = values[0];
    if (!experiment) throw new AdportError('INVALID_INPUT', 'microsoft: experiment was not found in the selected account');
    const context = await this.base(account, nativeId(experiment.BaseCampaignId)), branchId = optionalId(experiment.ExperimentCampaignId), branch = branchId ? await this.campaignById(account, branchId, context.base_campaign.CampaignType) : undefined;
    if (branchId && (!branch || optionalId(branch.ExperimentId) !== experimentId)) throw new AdportError('PROVIDER_ERROR', 'microsoft: experiment campaign ownership could not be verified');
    const visible = { account_id: account, experiment, base_context: context, ...(branch ? { experiment_campaign: branch } : {}) };
    return { ...visible, snapshot_hash: digest(visible), notes };
  }

  private eligible(context: Context) {
    const base = context.base_campaign;
    if (!['Audience', 'Search', 'Shopping', 'PerformanceMax'].includes(String(base.CampaignType)) || optionalId(base.ExperimentId) || !Object.hasOwn(base, 'ExperimentId') || optionalId(base.BudgetId) || base.SubType !== undefined && base.SubType !== null && base.SubType !== '' || rows(base.Settings).some(value => /dynamicsearch/i.test(String(value.Type)))) throw new AdportError('INVALID_INPUT', 'microsoft: experiments require a verified non-experiment base without shared budgets, Dynamic Search Ads, mixed or other specialized subtypes');
    if (base.BudgetType !== 'DailyBudgetStandard') throw new AdportError('INVALID_INPUT', 'microsoft: experiment base must use DailyBudgetStandard');
    micros(base.DailyBudget);
  }

  private budget(context: Context) {
    const value = micros(context.base_campaign.DailyBudget);
    return [{ target: `base campaign ${nativeId(context.base_campaign.Id)} inherited total daily pool (split, not additional)`, ...(context.currency ? { currency: context.currency } : {}), fromMicros: value, toMicros: value }];
  }

  private async unique(account: string, value: string, exceptExperiment?: string, exceptCampaign?: string) {
    const campaigns = rows(await this.campaigns(account)), experiments = await this.query(account, null);
    if (campaigns.some(row => nativeId(row.Id) !== exceptCampaign && typeof row.Name === 'string' && row.Name.toLowerCase() === value.toLowerCase()) || experiments.some(row => nativeId(row.Id) !== exceptExperiment && typeof row.Name === 'string' && row.Name.toLowerCase() === value.toLowerCase())) throw new AdportError('INVALID_INPUT', 'microsoft: experiment name conflicts with a visible campaign or experiment');
  }

  private interval(context: Context, start: string, end?: string, except?: string) {
    if (context.active_experiments.some(value => {
      if (nativeId(value.Id) === except) return false;
      const from = calendarDate(value.StartDate), to = calendarDate(value.EndDate) ?? '9999-12-31';
      return !from || start <= to && from <= (end ?? '9999-12-31');
    })) throw new AdportError('INVALID_INPUT', 'microsoft: experiment date range overlaps the visible active inventory or an existing range is unverifiable');
  }

  private async confirmed(ids: string[], verify: () => Promise<boolean>): Promise<string[]> {
    try { if (!await verify()) throw new Error('Native readback mismatch'); }
    catch { throw new AdportError('PROVIDER_ERROR', 'microsoft: experiment write was accepted but its readback is unconfirmed; reconcile these IDs before retrying', { resourceIds: ids }); }
    return ids;
  }

  private async removedAfterDelete(account: string, kind: 'experiment' | 'campaign', targetId: string, campaignType?: unknown): Promise<boolean> {
    const experiment = kind === 'experiment', collection = experiment ? 'Experiments' : 'Campaigns';
    const result = await this.client.request<Row>('campaign', 'POST', `${collection}/QueryByIds`, experiment
      ? { ExperimentIds: [targetId], ReturnAdditionalFields: additional }
      : { AccountId: account, CampaignIds: [targetId], CampaignType: campaignType, ReturnAdditionalFields: 'TargetSetting' }, await this.accountScope(account));
    const values = result[collection];
    if (!Array.isArray(values) || values.length > 1 || result.NestedPartialErrors !== undefined && result.NestedPartialErrors !== null && (!Array.isArray(result.NestedPartialErrors) || result.NestedPartialErrors.some(Boolean))) return false;
    const errors = z.array(z.record(z.string(), z.unknown()).nullable()).parse(result.PartialErrors ?? []).filter(value => value !== null);
    if (!errors.length) return values.every(value => value === null || nativeId(value.Id) === targetId && value[experiment ? 'ExperimentStatus' : 'Status'] === 'Deleted');
    // Live-confirmed receipts after deleting previously verified owned IDs:
    // 6110/null experiment and 1120/null campaign. Neither error is a general
    // not-found signal: ordinary reads still fail, and independent inventories
    // plus the preserved base are checked before reporting deletion success.
    return values.length === 1 && values[0] === null && errors.length === 1 && errors[0]!.Index === 0
      && errors[0]!.Code === (experiment ? 6110 : 1120)
      && errors[0]!.ErrorCode === (experiment ? 'ExperimentIdInvalid' : 'CampaignServiceInvalidCampaignStatus');
  }

  async plan(op: WriteOperation, guard: WriteGuard): Promise<MicrosoftPlan> {
    const kinds = { microsoft_create_experiment: 'create', microsoft_update_experiment: 'update', microsoft_end_experiment: 'update', microsoft_delete_experiment: 'remove' } as const;
    if (op.provider !== 'microsoft' || !MICROSOFT_EXPERIMENT_WRITES.has(op.tool) || op.kind !== kinds[op.tool as keyof typeof kinds]) throw new AdportError('INVALID_INPUT', 'microsoft: experiment operation kind mismatch');
    const account = op.accountId;
    if (op.tool === 'microsoft_create_experiment') {
      const input = create.parse(op.payload), context = await this.base(account, input.base_campaign_id, true); this.eligible(context);
      if (context.snapshot_hash !== input.expected_base_context_hash) throw new AdportError('PENDING_MISMATCH', 'microsoft: experiment base context changed; read fresh context and request a new preview');
      if (guard.forcePausedCreation && context.base_campaign.Status !== 'Paused') throw new AdportError('POLICY_VIOLATION', 'microsoft: experiment campaign status is inherited; paused_creation requires a currently Paused base campaign');
      await this.unique(account, input.name);
      const start = input.start_date;
      if (context.active_experiments.length >= 10) throw new AdportError('INVALID_INPUT', 'microsoft: visible experiment inventory has reached the native ten-experiment limit for this base');
      this.interval(context, start, input.end_date);
      const fields = { BaseCampaignId: input.base_campaign_id, Name: input.name, StartDate: nativeDate(start), ...(input.end_date ? { EndDate: nativeDate(input.end_date) } : {}), TrafficSplitPercent: input.traffic_split_percent, ExperimentType: input.experiment_type, ExperimentStatus: 'Active' };
      return { summary: `Create Microsoft experiment "${input.name}" from "${String(context.base_campaign.Name)}"`, changes: [`+ ${JSON.stringify(fields)}`, `Creates an asynchronous campaign copy inheriting base ${context.base_campaign.Status} status, ${context.base_campaign.DailyBudget} daily budget and ${context.base_campaign.TimeZone} timezone. Required native Active setup input transitions to Creating; it is not an independent branch activation.`, 'Existing total base daily allocation is split, not increased. Native name/history and experiment limits remain authoritative.'], fieldChanges: [{ field: 'Experiment', before: '(new)', after: input.name }, { field: 'Base campaign', before: '(none)', after: `${String(context.base_campaign.Name)} (${input.base_campaign_id})` }, { field: 'Experiment traffic/budget share', before: '0%', after: `${input.traffic_split_percent}% of existing base pool` }, { field: 'Inherited serving status', before: String(context.base_campaign.Status), after: String(context.base_campaign.Status) }], notes, coercions: [], budgetDeltas: this.budget(context), execute: async () => {
        const result = await this.request(account, 'Experiments', { Experiments: [fields] }), ids = z.array(z.unknown()).parse(result.ExperimentIds).filter(value => value !== null).map(nativeId);
        if (ids.length !== 1) throw new AdportError('PROVIDER_ERROR', 'microsoft: experiment creation receipt mismatch; reconcile before retrying', { resourceIds: ids });
        return this.confirmed(ids, async () => { const after = await this.get(account, ids[0]!); return nativeId(after.experiment.BaseCampaignId) === input.base_campaign_id && after.experiment.Name === input.name && ['Creating', 'Active', 'Paused', 'Scheduled'].includes(String(after.experiment.ExperimentStatus)) && (!guard.forcePausedCreation || after.base_context.base_campaign.Status === 'Paused' && (!after.experiment_campaign || after.experiment_campaign.Status === 'Paused')); });
      } };
    }
    const input = (op.tool === 'microsoft_update_experiment' ? update : reference).parse(op.payload), current = await this.get(account, input.experiment_id, true), experiment = current.experiment, context = current.base_context, status = String(experiment.ExperimentStatus);
    if (input.expected_snapshot_hash !== current.snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'microsoft: experiment or coupled campaign context changed; request a fresh preview');
    if (['Promoting', 'Graduating'].includes(status)) throw new AdportError('INVALID_INPUT', 'microsoft: reconcile the in-progress experiment transition before another mutation');
    if (op.tool === 'microsoft_delete_experiment') {
      const branchId = optionalId(experiment.ExperimentCampaignId), baseId = nativeId(experiment.BaseCampaignId);
      return { summary: `Delete Microsoft experiment "${String(experiment.Name)}" and its campaign copy`, changes: [`- experiment ${input.experiment_id}${branchId ? ` and experiment campaign ${branchId}` : ' (no experiment campaign ID returned yet)'}`, 'Native deletion is coupled to the experiment campaign. The base campaign is preserved.'], fieldChanges: [{ field: 'Experiment and campaign copy', before: `${String(experiment.Name)} (${input.experiment_id})`, after: 'Deleted together' }], notes, coercions: [], budgetDeltas: [], execute: async () => {
        await this.request(account, 'Experiments', { ExperimentIds: [input.experiment_id] }, 'DELETE');
        return this.confirmed([input.experiment_id, ...(branchId ? [branchId] : [])], async () => {
          if (!await this.removedAfterDelete(account, 'experiment', input.experiment_id) || branchId && !await this.removedAfterDelete(account, 'campaign', branchId, context.base_campaign.CampaignType)) return false;
          const base = await this.campaignById(account, baseId, context.base_campaign.CampaignType), active = await this.query(account, null), campaigns = rows(await this.campaigns(account));
          return !!base && base.Status === context.base_campaign.Status && base.DailyBudget === context.base_campaign.DailyBudget && !active.some(value => nativeId(value.Id) === input.experiment_id) && !campaigns.some(value => value.Status !== 'Deleted' && (nativeId(value.Id) === branchId || optionalId(value.ExperimentId) === input.experiment_id));
        });
      } };
    }
    if (!['Active', 'Paused', 'Scheduled', 'Ended'].includes(status)) throw new AdportError('INVALID_INPUT', 'microsoft: experiment is not in a supported settled state for this edit');
    let fields: Row, fieldChanges: Array<{ field: string; before: string; after: string }>;
    if (op.tool === 'microsoft_end_experiment') {
      if (status === 'Ended') throw new AdportError('INVALID_INPUT', 'microsoft: experiment is already ended');
      fields = { Id: input.experiment_id, ExperimentStatus: 'Ended' }; fieldChanges = [{ field: 'Experiment status', before: status, after: 'Ended (cannot restart)' }];
    } else {
      const edit = update.parse(input);
      if (status === 'Ended') throw new AdportError('INVALID_INPUT', 'microsoft: ended experiments cannot be edited; deletion is a separate operation');
      if ((edit.start_date !== undefined || edit.traffic_split_percent !== undefined) && status !== 'Scheduled') throw new AdportError('INVALID_INPUT', 'microsoft: start-date and split edits require native Scheduled status; Paused does not prove the experiment never started');
      const from = edit.start_date ?? calendarDate(experiment.StartDate), to = edit.end_date === null ? undefined : edit.end_date ?? calendarDate(experiment.EndDate);
      if (!from || to && from > to) throw new AdportError('INVALID_INPUT', 'microsoft: experiment date interval is invalid or unavailable');
      if (edit.start_date !== undefined || edit.end_date !== undefined) this.interval(context, from, to, input.experiment_id);
      if (edit.name !== undefined) await this.unique(account, edit.name, input.experiment_id, optionalId(experiment.ExperimentCampaignId));
      fields = { Id: input.experiment_id, ...(edit.name !== undefined ? { Name: edit.name } : {}), ...(edit.start_date !== undefined ? { StartDate: nativeDate(edit.start_date) } : {}), ...(edit.end_date !== undefined ? { EndDate: edit.end_date === null ? { Day: 0, Month: 0, Year: 0 } : nativeDate(edit.end_date) } : {}), ...(edit.traffic_split_percent !== undefined ? { TrafficSplitPercent: edit.traffic_split_percent } : {}) };
      fieldChanges = Object.entries(fields).filter(([key]) => key !== 'Id').map(([field, value]) => ({ field, before: JSON.stringify(experiment[field] ?? null), after: JSON.stringify(value) }));
    }
    return { summary: `${op.tool === 'microsoft_end_experiment' ? 'End' : 'Update'} Microsoft experiment "${String(experiment.Name)}"`, changes: [`~ ${JSON.stringify(fields)}`, 'Names are coupled to the experiment campaign; other branch settings, base status and the inherited total budget are preserved. Ending is irreversible and pauses the experiment campaign.'], fieldChanges, notes, coercions: [], budgetDeltas: this.budget(context), execute: async () => {
      await this.request(account, 'Experiments', { Experiments: [fields] }, 'PUT');
      return this.confirmed([input.experiment_id], async () => { const after = await this.get(account, input.experiment_id); return Object.entries(fields).filter(([key]) => key !== 'Id').every(([key, value]) => key === 'EndDate' ? calendarDate(after.experiment.EndDate) === calendarDate(value) : key === 'StartDate' ? calendarDate(after.experiment.StartDate) === calendarDate(value) : after.experiment[key] === value) && after.base_context.base_campaign.Status === context.base_campaign.Status && after.base_context.base_campaign.DailyBudget === context.base_campaign.DailyBudget && (op.tool !== 'microsoft_end_experiment' || !after.experiment_campaign || after.experiment_campaign.Status === 'Paused'); });
    } };
  }
}

export function microsoftExperimentTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'microsoft_experiments', namespace: 'microsoft', description: 'Read native active experiments only; this inventory does not establish absence of historical experiments. Use get for an exact known ID. Continue next_cursor as after_experiment_id.', input: z.object({ account_id: id, after_experiment_id: id.optional(), limit: z.number().int().positive().max(1000).default(100) }), output: z.object({ rows: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean(), next_cursor: id.optional(), visibility: z.string(), notes: z.array(z.string()) }), pagination: { cursorInput: 'after_experiment_id' }, annotations: { readOnly: true }, handler: input => provider.experiments.list(input) }),
    defineTool({ name: 'microsoft_experiment_base_context', namespace: 'microsoft', description: 'Read an owned base campaign, its native active experiments, currency and snapshot_hash for creation. Budgets/status/timezone are inherited by experiment copies. Snapshot covers campaign configuration and visible active inventory, not every child entity.', input: z.object({ account_id: id, base_campaign_id: id }), output: contextSchema, annotations: { readOnly: true }, handler: input => provider.experiments.base(input.account_id, input.base_campaign_id) }),
    defineTool({ name: 'microsoft_get_experiment', namespace: 'microsoft', description: 'Read an exact known experiment, verified base/experiment campaign ownership, native setup state and coupled snapshot_hash. Creating is asynchronous acceptance, not readiness.', input: z.object({ account_id: id, experiment_id: id }), output: viewSchema, annotations: { readOnly: true }, handler: input => provider.experiments.get(input.account_id, input.experiment_id) }),
    guardedWriteTool({ name: 'microsoft_create_experiment', namespace: 'microsoft', provider: 'microsoft', kind: 'create', description: 'Create a native campaign-copy experiment with expected_base_context_hash. Paused creation requires a currently Paused base; native Active setup input becomes Creating. Dates use base timezone. Splits existing daily budget/traffic rather than adding a pool. Shared-budget, DSA, mixed/specialized or experiment bases are rejected. Setup is asynchronous.', payload: create }),
    guardedWriteTool({ name: 'microsoft_update_experiment', namespace: 'microsoft', provider: 'microsoft', kind: 'update', description: 'Edit experiment name or calendar schedule with expected_snapshot_hash. Name changes rename the campaign copy. Native Scheduled status is required before changing start/split; Paused alone is insufficient. end_date:null clears expiry with the native zero Date. No promotion or graduation.', payload: update }),
    guardedWriteTool({ name: 'microsoft_end_experiment', namespace: 'microsoft', provider: 'microsoft', kind: 'update', description: 'End an owned settled experiment early with expected_snapshot_hash. This cannot be restarted and pauses its campaign copy; the base campaign is preserved. Pausing temporarily is instead coupled to pausing the base campaign.', payload: reference }),
    guardedWriteTool({ name: 'microsoft_delete_experiment', namespace: 'microsoft', provider: 'microsoft', kind: 'remove', description: 'Delete an exact owned experiment and its coupled campaign copy with expected_snapshot_hash; preserve the base. Confirms disappearance before success. Do not retry accepted-but-unconfirmed receipts without reconciling their IDs.', payload: reference }),
  ];
}
