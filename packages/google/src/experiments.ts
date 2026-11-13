import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteGuard, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import { GoogleAdsRestClient, normalizeCustomerId } from './client.js';
import type { GoogleAdsProvider } from './provider.js';

type Row = Record<string, unknown>;
type Campaign = { campaign: Row; budget: Row; budget_micros: number };
type ExperimentPlan = Omit<WritePreview, 'serverValidated'> & { serverValidated?: boolean; execute: (validateOnly: boolean) => Promise<string[]>; resultDetails?: () => unknown; resultWarnings?: () => string[] };
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const id = z.string().regex(/^[1-9]\d*$/), hash = z.string().regex(/^[a-f0-9]{64}$/), name = z.string().trim().min(1).max(1024), date = z.iso.date();
const systemType = z.enum(['SEARCH_CUSTOM', 'DISPLAY_CUSTOM', 'HOTEL_CUSTOM', 'YOUTUBE_CUSTOM', 'PMAX_REPLACEMENT_SHOPPING']);
const metricGoal = z.object({ metric: z.enum(['CLICKS', 'IMPRESSIONS', 'COST', 'CONVERSIONS_PER_INTERACTION_RATE', 'COST_PER_CONVERSION', 'CONVERSIONS_VALUE_PER_COST', 'AVERAGE_CPC', 'CTR', 'INCREMENTAL_CONVERSIONS', 'COMPLETED_VIDEO_VIEWS', 'CUSTOM_ALGORITHMS', 'CONVERSIONS', 'CONVERSION_VALUE']), direction: z.enum(['NO_CHANGE', 'INCREASE', 'DECREASE', 'NO_CHANGE_OR_INCREASE', 'NO_CHANGE_OR_DECREASE']) }).strict();
const experimentRef = { experiment_id: id, expected_experiment_hash: hash };
const settings = { name: name.optional(), description: z.string().max(2048).optional(), start_date: date.optional(), end_date: date.optional(), goals: z.array(metricGoal).max(20).optional() };
const performanceMax = z.object({ budget_amount_micros: z.number().int().positive().safe(), bidding_strategy_type: z.enum(['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS']), target_cpa_micros: z.number().int().positive().safe().optional(), target_roas: z.number().finite().positive().optional() }).strict().superRefine((value, ctx) => {
  const cpa = ['MAXIMIZE_CONVERSIONS', 'TARGET_CPA'].includes(value.bidding_strategy_type);
  if (cpa ? value.target_roas !== undefined : value.target_cpa_micros !== undefined) ctx.addIssue({ code: 'custom', message: 'Bidding target must match the selected strategy' });
  if (value.bidding_strategy_type === 'TARGET_CPA' && value.target_cpa_micros === undefined || value.bidding_strategy_type === 'TARGET_ROAS' && value.target_roas === undefined) ctx.addIssue({ code: 'custom', message: 'Target bidding strategy requires its matching target' });
});
const treatment = z.object({ name, traffic_split_percent: z.number().int().min(1).max(99), performance_max: performanceMax.optional() }).strict();
const create = z.object({ ...settings, name, base_campaign_id: id, expected_base_hash: hash, type: systemType, suffix: z.string().min(1).max(100), control_name: name.default('Control'), control_traffic_split_percent: z.number().int().min(1).max(99), treatments: z.array(treatment).min(1).max(20), sync_enabled: z.boolean().optional(), video_experiment_subtype: z.enum(['ASSET', 'ASSET_UPLIFT', 'DEMAND_GEN_ASSET']).optional() }).strict().superRefine((value, ctx) => {
  if (value.control_traffic_split_percent + value.treatments.reduce((sum, arm) => sum + arm.traffic_split_percent, 0) !== 100) ctx.addIssue({ code: 'custom', message: 'Control and treatment traffic shares must total 100' });
  if (new Set([value.control_name, ...value.treatments.map(arm => arm.name)]).size !== value.treatments.length + 1) ctx.addIssue({ code: 'custom', message: 'Arm names must be unique within this experiment' });
  if (value.type === 'YOUTUBE_CUSTOM' ? !value.video_experiment_subtype : value.video_experiment_subtype !== undefined) ctx.addIssue({ code: 'custom', message: 'Video subtype is required only for YOUTUBE_CUSTOM' });
  if (value.type !== 'PMAX_REPLACEMENT_SHOPPING' && value.treatments.some(arm => arm.performance_max)) ctx.addIssue({ code: 'custom', message: 'Performance Max settings apply only to PMAX_REPLACEMENT_SHOPPING' });
  if (value.start_date && value.end_date && value.start_date > value.end_date) ctx.addIssue({ code: 'custom', message: 'End date must not precede start date' });
});
const update = z.object({ ...experimentRef, ...settings }).strict().refine(value => Object.entries(value).some(([key, item]) => !['experiment_id', 'expected_experiment_hash'].includes(key) && item !== undefined), 'Supply an editable experiment field');
const armPatch = z.object({ arm_id: id, name: name.optional(), traffic_split_percent: z.number().int().min(1).max(99).optional() }).strict();
const patchArms = z.object({ ...experimentRef, arms: z.array(armPatch).min(1).max(100) }).strict();
const addArms = z.object({ ...experimentRef, treatments: z.array(treatment).min(1).max(20), existing_arms: z.array(armPatch).min(1).max(100) }).strict();
const removeArms = z.object({ ...experimentRef, arm_ids: z.array(id).min(1).max(100), remaining_arms: z.array(armPatch).max(100) }).strict();
const action = z.object({ ...experimentRef, confirm_serving_changes: z.literal(true) }).strict();
const graduate = action.safeExtend({ campaign_id: id, campaign_budget_id: id, expected_budget_hash: hash });
const exFields = 'experiment.resource_name, experiment.experiment_id, experiment.name, experiment.description, experiment.suffix, experiment.type, experiment.status, experiment.start_date, experiment.end_date, experiment.sync_enabled, experiment.goals, experiment.video_experiment.video_experiment_subtype, experiment.optimize_assets_experiment.optimize_assets_experiment_subtype, experiment.long_running_operation, experiment.promote_status';
const armFields = 'experiment_arm.resource_name, experiment_arm.experiment, experiment_arm.name, experiment_arm.control, experiment_arm.traffic_split, experiment_arm.campaigns, experiment_arm.in_design_campaigns';
const budgetFields = 'campaign_budget.resource_name, campaign_budget.id, campaign_budget.name, campaign_budget.status, campaign_budget.amount_micros, campaign_budget.total_amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count, campaign_budget.period, campaign_budget.delivery_method';
const campaignFields = `campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.experiment_type, campaign.base_campaign, campaign.campaign_budget, campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.manual_cpc.enhanced_cpc_enabled, campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas, campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas, campaign.target_spend.cpc_bid_ceiling_micros, ${budgetFields}`;
const kinds = { google_create_experiment: 'create', google_update_experiment: 'update', google_add_experiment_arms: 'create', google_update_experiment_arms: 'update', google_remove_experiment_arms: 'remove', google_remove_experiment: 'remove', google_schedule_experiment: 'update', google_end_experiment: 'update', google_promote_experiment: 'update', google_graduate_experiment: 'update' } as const;
export const GOOGLE_EXPERIMENT_WRITES = new Set(Object.keys(kinds));
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const camel = (key: string) => key.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
function micros(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw new AdportError('PROVIDER_ERROR', 'google: experiment budget micros are missing or outside the shared policy integer range');
  return Number(value);
}
function statusError(value: unknown) {
  const row = object(value);
  return { code: typeof row.code === 'number' && Number.isInteger(row.code) ? row.code : null, errors: list(row.details).flatMap(detail => list(object(detail).errors)).map(value => { const error = object(value); return { codes: Object.entries(object(error.errorCode)).flatMap(([key, val]) => typeof val === 'string' && /^[A-Z_]+$/.test(val) ? [`${key}.${val}`] : []), fields: list(object(error.location).fieldPathElements).flatMap(item => typeof object(item).fieldName === 'string' && /^[a-z][a-zA-Z0-9_]*$/.test(String(object(item).fieldName)) ? [object(item).fieldName] : []) }; }) };
}

/** Official v25 experiment/arm protos and discovery revision 20261102; live GAQL fields checked. */
export class GoogleExperimentService {
  constructor(private readonly client: GoogleAdsRestClient) {}

  private async account(accountId: string) {
    const selected = normalizeCustomerId(accountId), rows = await this.client.search(selected, 'SELECT customer.resource_name, customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 2', { maxRows: 2 }), customer = object(rows[0]?.customer);
    if (rows.length !== 1 || customer.id !== selected || customer.resourceName !== `customers/${selected}` || typeof customer.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(customer.currencyCode) || typeof customer.timeZone !== 'string' || !customer.timeZone) throw new AdportError('PROVIDER_ERROR', 'google: invalid experiment customer identity, currency or timezone');
    return customer;
  }
  private experiment(value: unknown, selected: string): Row {
    const row = object(value), match = typeof row.resourceName === 'string' ? row.resourceName.match(new RegExp(`^customers/${selected}/experiments/([1-9]\\d*)$`)) : null;
    if (!match || row.experimentId !== match[1] || typeof row.name !== 'string' || typeof row.type !== 'string' || typeof row.status !== 'string') throw new AdportError('PROVIDER_ERROR', 'google: invalid experiment identity or configuration');
    return row;
  }
  private campaignName(value: unknown, selected: string): string {
    if (typeof value !== 'string' || !new RegExp(`^customers/${selected}/campaigns/[1-9]\\d*$`).test(value)) throw new AdportError('PROVIDER_ERROR', 'google: experiment refers to a campaign outside the selected account');
    return value;
  }
  private async campaigns(selected: string, names: string[]): Promise<Campaign[]> {
    const wanted = [...new Set(names.map(value => this.campaignName(value, selected)))].sort();
    if (!wanted.length) return [];
    if (wanted.length > 1000) throw new AdportError('INVALID_INPUT', 'google: experiment campaign context exceeds the complete-read bound');
    const rows = await this.client.search(selected, `SELECT ${campaignFields} FROM campaign WHERE campaign.resource_name IN (${wanted.map(value => `'${value}'`).join(', ')}) LIMIT ${wanted.length + 1}`, { maxRows: wanted.length + 1, includeDrafts: true });
    const result = rows.map(value => {
      const campaign = object(value.campaign), budget = object(value.campaignBudget), resource = this.campaignName(campaign.resourceName, selected);
      if (!wanted.includes(resource) || campaign.id !== resource.split('/').at(-1) || !['ENABLED', 'PAUSED', 'REMOVED'].includes(String(campaign.status)) || campaign.campaignBudget !== budget.resourceName || typeof budget.resourceName !== 'string' || !new RegExp(`^customers/${selected}/campaignBudgets/[1-9]\\d*$`).test(budget.resourceName) || budget.period !== 'DAILY') throw new AdportError('PROVIDER_ERROR', 'google: incomplete experiment campaign identity, status or daily budget');
      return { campaign, budget, budget_micros: micros(budget.amountMicros ?? '0') };
    });
    if (result.length !== wanted.length || new Set(result.map(value => value.campaign.resourceName)).size !== result.length) throw new AdportError('INVALID_INPUT', 'google: complete experiment campaign context was not available, including native drafts');
    return result.sort((a, b) => String(a.campaign.resourceName).localeCompare(String(b.campaign.resourceName)));
  }
  async list(input: { account_id: string; limit: number; after_experiment_id?: string; include_removed?: boolean }) {
    const selected = normalizeCustomerId(input.account_id), predicates = [...(!input.include_removed ? ["experiment.status != 'REMOVED'"] : []), ...(input.after_experiment_id ? [`experiment.experiment_id > ${id.parse(input.after_experiment_id)}`] : [])];
    const rows = await this.client.search(selected, `SELECT ${exFields} FROM experiment${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''} ORDER BY experiment.experiment_id ASC LIMIT ${input.limit + 1}`, { maxRows: input.limit + 1 }), experiments = rows.map(value => this.experiment(value.experiment, selected));
    if (experiments.some((value, index) => BigInt(String(value.experimentId)) <= BigInt(index ? String(experiments[index - 1]!.experimentId) : input.after_experiment_id ?? '0'))) throw new AdportError('PROVIDER_ERROR', 'google: experiment continuation did not advance');
    return { experiments: experiments.slice(0, input.limit), truncated: experiments.length > input.limit, ...(experiments.length > input.limit ? { next_cursor: String(experiments[input.limit - 1]!.experimentId) } : {}) };
  }
  async context(input: { account_id: string; experiment_id?: string; base_campaign_id?: string; campaign_budget_id?: string }) {
    const selected = normalizeCustomerId(input.account_id), customer = await this.account(selected);
    let experiment: Row | undefined, arms: Row[] = [], related: Campaign[] = [];
    if (input.experiment_id) {
      id.parse(input.experiment_id);
      const resource = `customers/${selected}/experiments/${input.experiment_id}`, rows = await this.client.search(selected, `SELECT ${exFields} FROM experiment WHERE experiment.resource_name = '${resource}' LIMIT 2`, { maxRows: 2 });
      if (rows.length !== 1) throw new AdportError('INVALID_INPUT', 'google: experiment was not available in the selected account');
      experiment = this.experiment(rows[0]!.experiment, selected);
      if (experiment.resourceName !== resource) throw new AdportError('PROVIDER_ERROR', 'google: experiment ID mismatch');
      const armRows = await this.client.search(selected, `SELECT ${armFields} FROM experiment_arm WHERE experiment_arm.experiment = '${resource}' LIMIT 1001`, { maxRows: 1001 });
      if (armRows.length > 1000) throw new AdportError('INVALID_INPUT', 'google: complete arm context exceeds the read bound');
      arms = armRows.map(value => {
        const arm = object(value.experimentArm);
        if (typeof arm.resourceName !== 'string' || !new RegExp(`^customers/${selected}/experimentArms/${input.experiment_id}~[1-9]\\d*$`).test(arm.resourceName) || arm.experiment !== resource || typeof arm.name !== 'string' || !/^\d+$/.test(String(arm.trafficSplit ?? '0')) || BigInt(String(arm.trafficSplit ?? '0')) > 100n) throw new AdportError('PROVIDER_ERROR', 'google: invalid experiment arm identity or traffic split');
        const campaigns = list(arm.campaigns).map(value => this.campaignName(value, selected)).sort(), drafts = list(arm.inDesignCampaigns).map(value => this.campaignName(value, selected)).sort();
        return { ...arm, resourceName: arm.resourceName, control: arm.control === true, campaigns, inDesignCampaigns: drafts };
      }).sort((a, b) => String(a.resourceName).localeCompare(String(b.resourceName)));
      if (new Set(arms.map(value => value.resourceName)).size !== arms.length) throw new AdportError('PROVIDER_ERROR', 'google: duplicate experiment arms');
      related = await this.campaigns(selected, arms.flatMap(arm => [...list(arm.campaigns), ...list(arm.inDesignCampaigns)]).map(String));
    }
    const base = input.base_campaign_id ? (await this.campaigns(selected, [`customers/${selected}/campaigns/${id.parse(input.base_campaign_id)}`]))[0] : undefined;
    let budget: Row | undefined;
    if (input.campaign_budget_id) {
      const resource = `customers/${selected}/campaignBudgets/${id.parse(input.campaign_budget_id)}`, rows = await this.client.search(selected, `SELECT ${budgetFields} FROM campaign_budget WHERE campaign_budget.resource_name = '${resource}' LIMIT 2`, { maxRows: 2 });
      budget = object(rows[0]?.campaignBudget);
      if (rows.length !== 1 || budget.resourceName !== resource || budget.period !== 'DAILY') throw new AdportError('INVALID_INPUT', 'google: graduation daily budget was not available in the selected account');
      micros(budget.amountMicros ?? '0');
    }
    return { account: customer, ...(experiment ? { experiment, arms, campaigns: related, experiment_snapshot_hash: digest({ customer, experiment, arms, campaigns: related }) } : {}), ...(base ? { base_campaign: base, base_snapshot_hash: digest({ customer, base }) } : {}), ...(budget ? { graduation_budget: budget, budget_snapshot_hash: digest({ customer, budget }) } : {}), note: 'Snapshots cover the returned experiment/arms, campaign status/bidding and budget configuration; they do not freeze all underlying ads, keywords or targeting, and Google provides no atomic compare-and-set. Dates use the account timezone. Intra-campaign, asset-optimization and campaign-mix creation require separate native workflows.' };
  }
  private async checked(accountId: string, value: z.infer<typeof action> | z.infer<typeof update> | z.infer<typeof patchArms> | z.infer<typeof removeArms> | z.infer<typeof addArms> | z.infer<typeof graduate>) {
    const context = await this.context({ account_id: accountId, experiment_id: value.experiment_id, ...('campaign_budget_id' in value ? { campaign_budget_id: value.campaign_budget_id } : {}) });
    if (context.experiment_snapshot_hash !== value.expected_experiment_hash) throw new AdportError('PENDING_MISMATCH', 'google: experiment, arms or campaign/budget context changed; read it again');
    if (context.experiment!.status === 'REMOVED') throw new AdportError('INVALID_INPUT', 'google: removed experiment cannot be changed');
    return context;
  }
  private fields(value: Row) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [camel(key), item])); }
  private mutation(selected: string, service: 'experiments' | 'experimentArms', operations: Row[], summary: string, changes: string[], expected?: string[]): ExperimentPlan {
    return { summary, changes, coercions: [], budgetDeltas: [], notes: ['Native validateOnly previews make no changes. Experiment removal/arm removal may also remove their draft or treatment copies; control campaigns are preserved.', 'Metadata and draft setup are separate from serving. Native type/state/date restrictions remain authoritative.'], execute: async validateOnly => {
      const result = await this.client.mutate(selected, service, operations, { validateOnly });
      if (validateOnly) return [];
      const ids = result.results?.map(value => value.resourceName);
      if (!ids || ids.length !== operations.length || ids.some((value, index) => {
        const operation = operations[index]!, target = expected?.[index] ?? object(operation.update).resourceName ?? operation.remove;
        const armExperiment = String(object(operation.create).experiment ?? '').split('/').at(-1);
        const pattern = service === 'experiments' ? `^customers/${selected}/experiments/[1-9]\\d*$` : `^customers/${selected}/experimentArms/${target ? '[1-9]\\d*' : armExperiment}~[1-9]\\d*$`;
        return typeof value !== 'string' || !new RegExp(pattern).test(value) || target !== undefined && value !== target;
      })) throw new AdportError('PROVIDER_ERROR', 'google: experiment mutation receipt was not confirmed; reconcile before retrying', { resource_ids: ids?.filter(value => typeof value === 'string') ?? [] });
      return ids as string[];
    } };
  }
  private armInput(experiment: string, controlName: string, controlSplit: number, base: string, treatments: z.infer<typeof treatment>[]) {
    return [{ name: controlName, control: true, trafficSplit: String(controlSplit), campaigns: [base], experiment }, ...treatments.map(value => ({ name: value.name, control: false, trafficSplit: String(value.traffic_split_percent), experiment, ...(value.performance_max ? { performanceMaxExperimentArmInfo: { experimentalPerformanceMaxCampaignSettings: Object.fromEntries(Object.entries(value.performance_max).map(([key, item]) => [camel(key), /_micros$/.test(key) ? String(item) : item])) } } : {}) }))];
  }
  private async pauseDrafts(selected: string, experimentId: string, createdArms: string[], base: Campaign, treatmentBounds: number[], forcePaused: boolean) {
    const context = await this.context({ account_id: selected, experiment_id: experimentId }), fresh = createdArms.map(resource => context.arms!.find(value => value.resourceName === resource)), treatments = fresh.filter((value): value is Row => Boolean(value) && !value!.control), drafts = treatments.flatMap(value => list(value.inDesignCampaigns).map(String));
    if (context.experiment!.status !== 'SETUP' || fresh.some(value => !value) || fresh.some(value => value?.control && (list(value.campaigns).length !== 1 || list(value.campaigns)[0] !== base.campaign.resourceName)) || treatments.length !== treatmentBounds.length || treatments.some(value => list(value.inDesignCampaigns).length !== 1 || list(value.campaigns).length > 0) || drafts.length !== treatments.length || new Set(drafts).size !== drafts.length || drafts.includes(String(base.campaign.resourceName))) throw new AdportError('PROVIDER_ERROR', 'google: generated treatment drafts were not confirmed; inspect the SETUP experiment before retrying', { resource_ids: [String(context.experiment!.resourceName), ...createdArms] });
    const copies = context.campaigns!.filter(value => drafts.includes(String(value.campaign.resourceName)));
    if (copies.length !== drafts.length || copies.some(value => value.campaign.experimentType !== 'DRAFT' || value.campaign.baseCampaign && value.campaign.baseCampaign !== base.campaign.resourceName)) throw new AdportError('PROVIDER_ERROR', 'google: native generated campaign ownership/type mismatch; SETUP was not scheduled', { resource_ids: [...createdArms, ...drafts] });
    if (forcePaused) {
      const operations = copies.filter(value => value.campaign.status !== 'PAUSED').map(value => ({ update: { resourceName: value.campaign.resourceName, status: 'PAUSED' }, updateMask: 'status' }));
      if (operations.length) {
        await this.client.mutate(selected, 'campaigns', operations, { validateOnly: true });
        const result = await this.client.mutate(selected, 'campaigns', operations, { validateOnly: false }), names = result.results?.map(value => value.resourceName);
        if (!names || names.length !== operations.length || names.some((value, index) => value !== operations[index]!.update.resourceName)) throw new AdportError('PROVIDER_ERROR', 'google: draft pause was not confirmed; inspect these SETUP drafts before retrying', { resource_ids: drafts });
      }
    }
    const after = await this.campaigns(selected, drafts);
    if (after.some(value => forcePaused && value.campaign.status !== 'PAUSED' || value.budget_micros > treatmentBounds[drafts.indexOf(String(value.campaign.resourceName))]!)) throw new AdportError('PROVIDER_ERROR', 'google: copied draft status or budget exceeds the approved plan; the experiment remains unscheduled', { resource_ids: drafts });
    return drafts;
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<ExperimentPlan> {
    if (!GOOGLE_EXPERIMENT_WRITES.has(op.tool) || op.provider !== 'google' || op.kind !== kinds[op.tool as keyof typeof kinds]) throw new AdportError('INVALID_INPUT', 'google: invalid experiment operation kind');
    const selected = normalizeCustomerId(op.accountId);
    if (op.tool === 'google_create_experiment') return this.create(selected, create.parse(op.payload), guard);
    if (['google_add_experiment_arms', 'google_update_experiment_arms', 'google_remove_experiment_arms'].includes(op.tool)) return this.changeArms(selected, op, guard);
    const input = op.tool === 'google_update_experiment' ? update.parse(op.payload) : op.tool === 'google_graduate_experiment' ? graduate.parse(op.payload) : ['google_schedule_experiment', 'google_promote_experiment'].includes(op.tool) ? action.parse(op.payload) : z.object(experimentRef).strict().parse(op.payload);
    const context = await this.checked(selected, input), experiment = context.experiment!, resource = String(experiment.resourceName);
    if (op.tool === 'google_remove_experiment') return this.mutation(selected, 'experiments', [{ remove: resource }], `Remove Google experiment “${String(experiment.name)}”`, [`- ${resource}; arms ${context.arms!.map(value => value.resourceName).join(', ')}. Native removal may also remove its draft/treatment copies; base campaigns are retained.`], [resource]);
    if (op.tool === 'google_update_experiment') {
      const { experiment_id: _id, expected_experiment_hash: _hash, ...settings } = update.parse(input), fields = this.fields(settings), masks = Object.keys(settings).filter(key => settings[key as keyof typeof settings] !== undefined);
      const start = fields.startDate ?? experiment.startDate, end = fields.endDate ?? experiment.endDate;
      if (typeof start === 'string' && typeof end === 'string' && start > end) throw new AdportError('INVALID_INPUT', 'google: end date precedes start date');
      const plan = this.mutation(selected, 'experiments', [{ update: { resourceName: resource, ...fields }, updateMask: masks.join(',') }], `Update Google experiment “${String(experiment.name)}”`, masks.map(key => `~ ${key}: ${JSON.stringify(experiment[camel(key)] ?? null)} → ${JSON.stringify(fields[camel(key)])}`), [resource]);
      return { ...plan, fieldChanges: masks.map(key => ({ field: key, before: JSON.stringify(experiment[camel(key)] ?? null), after: JSON.stringify(fields[camel(key)]) })) };
    }
    if (op.tool === 'google_schedule_experiment' && guard.forcePausedCreation) throw new AdportError('POLICY_VIOLATION', 'google: ScheduleExperiment can materialize serving campaigns and exposes no paused-creation flag. paused_creation blocks this native active workflow; no schedule request was sent.');
    const methods = { google_schedule_experiment: 'scheduleExperiment', google_end_experiment: 'endExperiment', google_promote_experiment: 'promoteExperiment', google_graduate_experiment: 'graduateExperiment' } as const;
    const method = methods[op.tool as keyof typeof methods];
    if (!method) throw new AdportError('INVALID_INPUT', 'google: unsupported experiment lifecycle action');
    let payload: Row = {}, deltas: WritePreview['budgetDeltas'] = [];
    if (op.tool === 'google_graduate_experiment') {
      const value = graduate.parse(input), target = `customers/${selected}/campaigns/${value.campaign_id}`, campaign = context.campaigns!.find(value => value.campaign.resourceName === target), treatmentNames = context.arms!.filter(value => !value.control).flatMap(value => list(value.campaigns));
      const budget = context.graduation_budget!;
      if (!campaign || !treatmentNames.includes(target) || campaign.campaign.experimentType !== 'EXPERIMENT' || context.budget_snapshot_hash !== value.expected_budget_hash) throw new AdportError('PENDING_MISMATCH', 'google: graduation campaign or budget does not match the current treatment and budget snapshot');
      if (budget.status !== 'ENABLED' || budget.explicitlyShared === true || BigInt(String(budget.referenceCount ?? '0')) > (campaign.campaign.campaignBudget === budget.resourceName ? 1n : 0n)) throw new AdportError('INVALID_INPUT', 'google: graduation needs an available non-shared budget unused by other campaigns');
      deltas = [{ target: `graduated campaign ${value.campaign_id} daily budget`, fromMicros: campaign.budget_micros, toMicros: micros(budget.amountMicros ?? '0') }];
      payload = { campaignBudgetMappings: [{ experimentCampaign: target, campaignBudget: budget.resourceName }] };
    } else if (op.tool !== 'google_end_experiment') {
      const maximum = Math.max(0, ...context.campaigns!.map(value => value.budget_micros));
      deltas = context.campaigns!.map(value => ({ target: `${String(value.campaign.name)} native lifecycle daily budget ceiling`, fromMicros: value.budget_micros, toMicros: maximum }));
    }
    let details: unknown;
    return { summary: `${method.replace('Experiment', '')} Google experiment “${String(experiment.name)}”`, changes: [`~ ${resource}: ${method}.`, ...(method === 'endExperiment' ? ['Ends native experiment serving immediately; treatment campaigns are not deleted.'] : ['This native action can change serving, bidding, campaign configuration or budget allocation. Explicit serving confirmation was supplied.', 'Scheduling/promotion applies native behavior, including changes below campaign level; the snapshot is not a complete immutable copy of all ads, keywords or targeting.']), ...(Object.keys(payload).length ? [`~ ${JSON.stringify(payload)}`] : [])], notes: ['Dates use the customer timezone. Native validation does not promise future eligibility or successful asynchronous processing.', 'Budget deltas use a conservative configured daily ceiling for lifecycle effects; native traffic splitting is not an additional independent spend guarantee.', 'No automatic retry. Check experiment context, the current long-running operation and asynchronous errors after submission.'], coercions: [], budgetDeltas: deltas, resultDetails: () => details, execute: async validateOnly => {
      const result = await this.client.experimentAction(selected, String(experiment.experimentId), method, payload, validateOnly);
      if (validateOnly) return [];
      if (method === 'scheduleExperiment' || method === 'promoteExperiment') {
        const operation = result.name;
        if (typeof operation !== 'string' || !new RegExp(`^customers/${selected}/operations/[^\\s/\\\\?#%]{1,512}$`).test(operation) || ['.', '..'].includes(operation.split('/').at(-1)!) || object(result.metadata).experiment !== undefined && object(result.metadata).experiment !== resource) throw new AdportError('PROVIDER_ERROR', 'google: experiment operation acknowledgement was not confirmed; inspect native state before retrying', { resource_ids: [resource] });
        details = { status: 'ACCEPTED_FOR_PROCESSING', processed: false, operation_name: operation, experiment_id: experiment.experimentId, next_tool: 'google_experiment_operation', note: 'Only native submission is confirmed. Poll the operation and inspect experiment async errors; do not resubmit automatically.' };
      } else details = { status: 'NATIVE_ACTION_ACCEPTED', experiment_id: experiment.experimentId, next_tool: 'google_experiment_context', note: 'The synchronous native command returned successfully. Read current experiment/campaign state before further changes.' };
      return [resource];
    } };
  }

  private async create(selected: string, input: z.infer<typeof create>, guard: WriteGuard): Promise<ExperimentPlan> {
    const context = await this.context({ account_id: selected, base_campaign_id: input.base_campaign_id }), base = context.base_campaign!;
    if (context.base_snapshot_hash !== input.expected_base_hash) throw new AdportError('PENDING_MISMATCH', 'google: experiment base campaign or budget changed; read its context again');
    const channels: Record<z.infer<typeof systemType>, string[]> = { SEARCH_CUSTOM: ['SEARCH'], DISPLAY_CUSTOM: ['DISPLAY'], HOTEL_CUSTOM: ['HOTEL'], YOUTUBE_CUSTOM: ['VIDEO', 'DEMAND_GEN'], PMAX_REPLACEMENT_SHOPPING: ['SHOPPING'] };
    if (base.campaign.experimentType !== 'BASE' || !['ENABLED', 'PAUSED'].includes(String(base.campaign.status)) || !channels[input.type].includes(String(base.campaign.advertisingChannelType)) || base.budget.explicitlyShared === true || base.budget.status !== 'ENABLED') throw new AdportError('INVALID_INPUT', 'google: system-managed experiment needs an available base campaign of the matching channel with a non-shared enabled daily budget');
    const temporary = `customers/${selected}/experiments/-1`;
    const metadata = { resourceName: temporary, name: input.name, type: input.type, status: 'SETUP', suffix: input.suffix, ...this.fields({ description: input.description, start_date: input.start_date, end_date: input.end_date, goals: input.goals, sync_enabled: input.sync_enabled }), ...(input.video_experiment_subtype ? { videoExperiment: { videoExperimentSubtype: input.video_experiment_subtype } } : {}) };
    const arms = this.armInput(temporary, input.control_name, input.control_traffic_split_percent, String(base.campaign.resourceName), input.treatments), operations = [{ experimentOperation: { create: metadata } }, ...arms.map(value => ({ experimentArmOperation: { create: value } }))];
    const bounds = input.treatments.map(value => value.performance_max?.budget_amount_micros ?? base.budget_micros);
    let details: unknown;
    return { summary: `Create Google ${input.type} experiment “${input.name}” in SETUP`, changes: [`+ Experiment, one control arm and ${input.treatments.length} treatment arm(s) in one atomic native transaction. Base ${String(base.campaign.name)} (${input.base_campaign_id}) stays ${String(base.campaign.status)}.`, `+ Control traffic ${input.control_traffic_split_percent}%; treatments ${input.treatments.map(value => `${value.name}: ${value.traffic_split_percent}%`).join(', ')}.`, 'Native treatment arms generate in-design draft campaigns. SETUP is unscheduled and cannot serve experiment traffic. Scheduling is a separate guarded operation.'], coercions: guard.forcePausedCreation ? ['Generated treatment campaign status is coerced to PAUSED after native creation, while the experiment remains SETUP (paused_creation).'] : [], budgetDeltas: bounds.map((value, index) => ({ target: `new treatment “${input.treatments[index]!.name}” daily configuration upper bound`, fromMicros: 0, toMicros: value })), serverValidated: !guard.forcePausedCreation, notes: ['Native validateOnly checks the atomic experiment/arm creation. Generated draft IDs do not exist in a preview, so a required follow-up pause cannot be server-validated until apply; serverValidated=false reports that limit.', 'Apply confirms the created identities, validates/applies any required pause, and verifies the draft status and configured daily budget bound. A partial follow-up failure returns resource IDs for reconciliation and never schedules or retries the experiment.', 'Configured draft budget bounds are conservative policy inputs; native experiment traffic/budget sharing is not a promise of independent additional spend. Dates use the customer timezone.'], resultDetails: () => details, execute: async validateOnly => {
      const result = await this.client.googleAdsMutate(selected, operations, { validateOnly, responseContentType: 'MUTABLE_RESOURCE' });
      if (validateOnly) return [];
      const response = result.mutateOperationResponses, experiment = object(response?.[0]?.experimentResult), resource = experiment.resourceName;
      const created = response?.slice(1).map(value => object(value.experimentArmResult).resourceName);
      if (!response || response.length !== operations.length || typeof resource !== 'string' || !new RegExp(`^customers/${selected}/experiments/[1-9]\\d*$`).test(resource) || !created || created.some(value => typeof value !== 'string' || !new RegExp(`^customers/${selected}/experimentArms/${resource.split('/').at(-1)}~[1-9]\\d*$`).test(value)) || new Set(created).size !== created.length) throw new AdportError('PROVIDER_ERROR', 'google: atomic experiment creation receipt was not confirmed; find this experiment before another create', { resource_ids: [resource, ...(created ?? [])].filter(value => typeof value === 'string') });
      const experimentId = resource.split('/').at(-1)!, ids = created as string[];
      try {
        const current = await this.context({ account_id: selected, experiment_id: experimentId });
        if (current.experiment!.name !== input.name || current.experiment!.type !== input.type || current.experiment!.status !== 'SETUP' || ids.some((value, index) => { const arm = current.arms!.find(arm => arm.resourceName === value), wanted = arms[index]!; return !arm || arm.name !== wanted.name || arm.control !== wanted.control || arm.trafficSplit !== wanted.trafficSplit; })) throw new AdportError('PROVIDER_ERROR', 'google: experiment creation readback differs from the approved setup');
        const drafts = await this.pauseDrafts(selected, experimentId, ids, base, bounds, guard.forcePausedCreation);
        details = { status: 'SETUP', experiment_id: experimentId, arm_ids: ids, draft_campaign_ids: drafts, paused_by_policy: guard.forcePausedCreation, scheduled: false, next_tool: 'google_experiment_context' };
        return [resource, ...ids, ...drafts];
      } catch (error) { throw new AdportError('PROVIDER_ERROR', `${error instanceof Error ? error.message : 'google: setup follow-up was not confirmed'}. Creation was acknowledged but not retried; inspect this unscheduled experiment and its drafts.`, { resource_ids: [resource, ...ids] }); }
    } };
  }

  private patchedArms(selected: string, experimentId: string, current: Row[], patches: z.infer<typeof armPatch>[]) {
    if (new Set(patches.map(value => value.arm_id)).size !== patches.length) throw new AdportError('INVALID_INPUT', 'google: duplicate arm IDs');
    const operations: Row[] = [], after = current.map(value => ({ ...value }));
    for (const patch of patches) {
      const resource = `customers/${selected}/experimentArms/${experimentId}~${patch.arm_id}`, arm = after.find(value => value.resourceName === resource);
      if (!arm) throw new AdportError('INVALID_INPUT', 'google: arm does not belong to this experiment');
      const values = { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.traffic_split_percent !== undefined ? { trafficSplit: String(patch.traffic_split_percent) } : {}) };
      if (!Object.keys(values).length) continue;
      Object.assign(arm, values);
      operations.push({ update: { resourceName: resource, ...values }, updateMask: Object.keys(values).map(key => key === 'trafficSplit' ? 'traffic_split' : key).join(',') });
    }
    return { operations, after };
  }
  private validArms(arms: Row[]) {
    if (arms.length && (arms.filter(value => value.control).length !== 1 || arms.reduce((sum, value) => sum + Number(value.trafficSplit), 0) !== 100 || new Set(arms.map(value => value.name)).size !== arms.length)) throw new AdportError('INVALID_INPUT', 'google: final arm set must have one control, unique names and traffic totaling 100');
  }
  private async changeArms(selected: string, op: WriteOperation, guard: WriteGuard): Promise<ExperimentPlan> {
    const input = op.tool === 'google_add_experiment_arms' ? addArms.parse(op.payload) : op.tool === 'google_remove_experiment_arms' ? removeArms.parse(op.payload) : patchArms.parse(op.payload), context = await this.checked(selected, input), experiment = context.experiment!, arms = context.arms!;
    if (experiment.status !== 'SETUP' || !systemType.safeParse(experiment.type).success) throw new AdportError('INVALID_INPUT', 'google: arm setup tools require an unscheduled system-managed SETUP experiment');
    const patches = 'existing_arms' in input ? input.existing_arms : 'remaining_arms' in input ? input.remaining_arms : input.arms;
    const patched = this.patchedArms(selected, input.experiment_id, arms, patches);
    let operations = patched.operations, bounds: number[] = [], newArms: Row[] = [], base: Campaign | undefined;
    if ('treatments' in input) {
      const controls = arms.filter(value => value.control), names = controls.flatMap(value => list(value.campaigns));
      if (controls.length !== 1 || names.length !== 1) throw new AdportError('INVALID_INPUT', 'google: treatment creation requires one verified control campaign');
      base = context.campaigns!.find(value => value.campaign.resourceName === names[0]);
      if (!base || base.campaign.experimentType !== 'BASE' || base.budget.explicitlyShared === true) throw new AdportError('INVALID_INPUT', 'google: base campaign or non-shared budget was not available');
      if (experiment.type !== 'PMAX_REPLACEMENT_SHOPPING' && input.treatments.some(value => value.performance_max)) throw new AdportError('INVALID_INPUT', 'google: Performance Max settings do not match this experiment type');
      newArms = this.armInput(String(experiment.resourceName), '', 0, '', input.treatments).slice(1);
      bounds = input.treatments.map(value => value.performance_max?.budget_amount_micros ?? base!.budget_micros);
      this.validArms([...patched.after, ...newArms]);
      operations = [...operations, ...newArms.map(value => ({ create: value }))];
    } else if ('arm_ids' in input) {
      if (new Set(input.arm_ids).size !== input.arm_ids.length) throw new AdportError('INVALID_INPUT', 'google: duplicate removed arm IDs');
      const removed = input.arm_ids.map(value => `customers/${selected}/experimentArms/${input.experiment_id}~${value}`);
      if (removed.some(value => !arms.some(arm => arm.resourceName === value)) || patches.some(value => input.arm_ids.includes(value.arm_id))) throw new AdportError('INVALID_INPUT', 'google: removed arms must belong to this experiment and cannot also be updated');
      this.validArms(patched.after.filter(value => !removed.includes(String(value.resourceName))));
      operations = [...operations, ...removed.map(resource => ({ remove: resource }))];
    } else {
      this.validArms(patched.after);
      if (!operations.length) throw new AdportError('INVALID_INPUT', 'google: supply arm names or traffic shares to update');
    }
    const plan = this.mutation(selected, 'experimentArms', operations, `${op.tool === 'google_add_experiment_arms' ? 'Add' : op.tool === 'google_remove_experiment_arms' ? 'Remove' : 'Update'} Google experiment arms`, operations.map(value => `~ ${JSON.stringify(value)}`));
    if (!newArms.length) return plan;
    let details: unknown;
    return { ...plan, serverValidated: !guard.forcePausedCreation, coercions: guard.forcePausedCreation ? ['New generated treatment draft campaigns are coerced to PAUSED while SETUP remains unscheduled (paused_creation).'] : [], budgetDeltas: bounds.map((value, index) => ({ target: `new treatment “${String(newArms[index]!.name)}” daily configuration upper bound`, fromMicros: 0, toMicros: value })), notes: [...(plan.notes ?? []), 'The generated draft pause can only be native-validated after the server assigns draft IDs; serverValidated=false reports this deferred policy follow-up. Partial creation is never retried or scheduled automatically.'], resultDetails: () => details, execute: async validateOnly => {
      const ids = await plan.execute(validateOnly);
      if (validateOnly) return [];
      const created = ids.slice(ids.length - newArms.length);
      try {
        const drafts = await this.pauseDrafts(selected, input.experiment_id, created, base!, bounds, guard.forcePausedCreation);
        details = { status: 'SETUP', experiment_id: input.experiment_id, arm_ids: created, draft_campaign_ids: drafts, paused_by_policy: guard.forcePausedCreation, scheduled: false, next_tool: 'google_experiment_context' };
        return [...ids, ...drafts];
      } catch (error) { throw new AdportError('PROVIDER_ERROR', `${error instanceof Error ? error.message : 'google: arm follow-up was not confirmed'}. The native arm request was acknowledged; inspect SETUP before retrying.`, { resource_ids: [String(experiment.resourceName), ...ids] }); }
    } };
  }

  async asyncErrors(input: { account_id: string; experiment_id: string; page_size: number; page_token?: string }) {
    const context = await this.context(input), result = await this.client.experimentAsyncErrors(input.account_id, input.experiment_id, input.page_size, input.page_token);
    if (result.errors !== undefined && !Array.isArray(result.errors) || result.nextPageToken !== undefined && (typeof result.nextPageToken !== 'string' || !result.nextPageToken || result.nextPageToken === input.page_token)) throw new AdportError('PROVIDER_ERROR', 'google: invalid experiment async error page or nonadvancing cursor');
    return { experiment_id: input.experiment_id, status: context.experiment!.status, errors: list(result.errors).map(statusError), truncated: Boolean(result.nextPageToken), ...(typeof result.nextPageToken === 'string' ? { next_page_token: result.nextPageToken } : {}) };
  }
  async operation(input: { account_id: string; experiment_id: string }) {
    const context = await this.context(input), experiment = context.experiment!, current = experiment.longRunningOperation;
    if (typeof current !== 'string' || !current) return { experiment_id: input.experiment_id, experiment_status: experiment.status, state: 'NO_OPERATION_REPORTED', note: 'The experiment has no current long-running operation. This is not proof of successful scheduling or promotion.' };
    const result = await this.client.experimentOperation(input.account_id, current), metadata = object(result.metadata);
    if (result.name !== current || metadata.experiment !== undefined && metadata.experiment !== experiment.resourceName || result.done !== undefined && typeof result.done !== 'boolean' || result.done !== true && (result.error !== undefined || result.response !== undefined) || result.error !== undefined && result.response !== undefined) throw new AdportError('PROVIDER_ERROR', 'google: experiment operation identity or completion result mismatch');
    const done = result.done === true, error = result.error !== undefined ? statusError(result.error) : undefined;
    return { experiment_id: input.experiment_id, operation_name: current, experiment_status: experiment.status, state: !done ? 'PROCESSING' : error ? 'FAILED' : result.response !== undefined ? 'SUCCEEDED' : 'UNKNOWN', done, ...(error ? { error } : {}), note: 'Inspect native asynchronous experiment errors even after a completed operation. Operation completion alone does not guarantee campaign serving or experiment performance.' };
  }
}

export function googleExperimentTools(provider: GoogleAdsProvider): AnyToolDefinition[] {
  const ref = z.object(experimentRef).strict();
  return [
    defineTool({ name: 'google_experiments', namespace: 'google', description: 'List account-owned experiment configuration, lifecycle and latest operation. Continue next_cursor as after_experiment_id. No campaigns are created or scheduled.', input: z.object({ account_id: z.string(), limit: z.number().int().positive().max(100).default(25), after_experiment_id: id.optional(), include_removed: z.boolean().default(false) }), annotations: { readOnly: true }, pagination: { cursorInput: 'after_experiment_id' }, handler: input => provider.experiments.list(input) }),
    defineTool({ name: 'google_experiment_context', namespace: 'google', description: 'Read experiment/arms and their scoped base/draft/trial campaigns, daily budgets, currency/timezone and snapshot hashes. Supply base_campaign_id before create, experiment_id before edits/actions, and campaign_budget_id for graduation. Hashes cover returned configuration, not every underlying ad/keyword/target.', input: z.object({ account_id: z.string(), experiment_id: id.optional(), base_campaign_id: id.optional(), campaign_budget_id: id.optional() }), annotations: { readOnly: true }, handler: input => provider.experiments.context(input) }),
    defineTool({ name: 'google_experiment_async_errors', namespace: 'google', description: 'Read the selected experiment’s native scheduling/promotion errors. Returns enum/field diagnostics without sensitive native value echoes; continue next_page_token with identical selection.', input: z.object({ account_id: z.string(), experiment_id: id, page_size: z.number().int().positive().max(1000).default(100), page_token: z.string().min(1).max(16384).optional() }), annotations: { readOnly: true }, pagination: { cursorInput: 'page_token' }, handler: input => provider.experiments.asyncErrors(input) }),
    defineTool({ name: 'google_experiment_operation', namespace: 'google', description: 'Read only the current account-scoped operation named by this verified experiment. Distinguishes PROCESSING, SUCCEEDED, FAILED and UNKNOWN; no scheduling, cancellation or retry.', input: z.object({ account_id: z.string(), experiment_id: id }), annotations: { readOnly: true }, handler: input => provider.experiments.operation(input) }),
    ...([
      ['google_create_experiment', 'Create an unscheduled system-managed experiment with control/treatment arms in one native atomic request. Native draft copies are verified and paused by policy before success; no base pause, scheduling or serving. Requires expected_base_hash. Budget bounds use micros. Deferred draft pausing is reported as not fully server-validated.', create],
      ['google_update_experiment', 'Edit supplied experiment name/description/dates/goals through exact masks and expected_experiment_hash. Type and sync choice stay immutable; lifecycle transitions use their named actions.', update],
      ['google_add_experiment_arms', 'Add generated treatment draft arms to SETUP and atomically rebalance supplied existing arm shares. Final traffic totals 100. New draft copies are checked/paused under policy, with explicit deferred validation and budget bounds.', addArms],
      ['google_update_experiment_arms', 'Atomically edit owned SETUP arm names/traffic while preserving control roles and campaign references. Final arm set needs one control and 100% total traffic.', patchArms],
      ['google_remove_experiment_arms', 'Remove owned SETUP arms and atomically rebalance remaining traffic. Native removal may delete their draft copies. Control campaigns are retained; removing the control requires removing the full arm set.', removeArms],
      ['google_remove_experiment', 'Remove the verified experiment through native mutate. Preview lists associated arms/campaign copies; native type/state constraints and protected-account policy still apply.', ref],
      ['google_schedule_experiment', 'Materialize and schedule a SETUP experiment with explicit serving confirmation and expected_experiment_hash. Native action can start serving campaigns and has no paused-creation flag, so paused_creation blocks it. Otherwise native validateOnly previews, then apply returns an asynchronous operation.', action],
      ['google_end_experiment', 'Immediately end the verified experiment through native EndExperiment, with validateOnly preview. Treatment campaigns stop serving but are retained; no campaign is promoted or graduated.', ref],
      ['google_promote_experiment', 'Apply the current treatment configuration to its base through native promotion. Explicit serving confirmation and expected_experiment_hash required. Preview includes conservative daily budget ceilings; async submission is separate from completion.', action],
      ['google_graduate_experiment', 'Graduate one verified treatment campaign to an independent campaign using an owned, unused non-shared daily budget. Requires current experiment/budget hashes and explicit serving confirmation; reports the budget delta in micros.', graduate],
    ] as const).map(([tool, description, payload]) => guardedWriteTool({ name: tool, namespace: 'google', provider: 'google', kind: kinds[tool], description, payload, ...(tool === 'google_create_experiment' ? { destructive: false } : {}) })),
  ];
}
