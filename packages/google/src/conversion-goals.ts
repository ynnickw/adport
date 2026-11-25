import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type ReviewField, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import { GoogleAdsRestClient, normalizeCustomerId } from './client.js';
import type { GoogleConversionService } from './conversions.js';
import type { GoogleAdsProvider } from './provider.js';

type Row = Record<string, unknown>;
interface Plan extends Omit<WritePreview, 'serverValidated'> { execute(validateOnly: boolean): Promise<string[]>; resultDetails?: () => unknown }
interface Goal { resourceName: string; id: string; name: string; status: string; conversionActions: string[] }
interface Standard { resourceName: string; category: string; origin: string; biddable: boolean }
interface CampaignGoals { campaign: Row; config: { resourceName: string; level: 'CUSTOMER' | 'CAMPAIGN'; goal: string | null }; standard: Standard[] }
const id = z.string().regex(/^[1-9]\d*$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const ORIGINS = ['WEBSITE', 'GOOGLE_HOSTED', 'APP', 'CALL_FROM_ADS', 'STORE', 'YOUTUBE_HOSTED', 'LOCAL_SERVICES_ADS'] as const;
const unique = (values: string[]) => new Set(values).size === values.length;
const campaignIds = z.array(id).min(1).max(50).refine(unique, 'Campaign IDs must be unique');
const actionIds = z.array(id).min(1).max(100).refine(unique, 'Conversion action IDs must be unique');
const goalName = z.string().trim().min(1).max(255);
const createGoal = z.object({ name: goalName, conversion_action_ids: actionIds });
const toggle = z.object({ category: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/), origin: z.enum(ORIGINS), biddable: z.boolean() }).strict();
const target = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CUSTOM_GOAL'), custom_conversion_goal_id: id, expected_goal_hash: hash }).strict(),
  z.object({ type: z.literal('ACCOUNT_DEFAULT') }).strict(),
]);
const setGoal = z.object({ campaign_ids: campaignIds, expected_snapshot_hash: hash, goal: target.optional(), standard_goals: z.union([z.literal('DISABLE_ALL'), z.array(toggle).min(1).max(100)]).optional() }).superRefine((value, ctx) => {
  if (!value.goal && !value.standard_goals) ctx.addIssue({ code: 'custom', message: 'Supply goal, standard_goals or both' });
  if (value.goal?.type === 'ACCOUNT_DEFAULT' && value.standard_goals) ctx.addIssue({ code: 'custom', message: 'ACCOUNT_DEFAULT restores account goals; standard_goals would switch the campaigns back to campaign-level goals' });
  if (Array.isArray(value.standard_goals) && !unique(value.standard_goals.map(item => `${item.category}~${item.origin}`))) ctx.addIssue({ code: 'custom', message: 'Each category/origin pair can appear once' });
});
const goalFields = 'custom_conversion_goal.resource_name, custom_conversion_goal.id, custom_conversion_goal.name, custom_conversion_goal.status, custom_conversion_goal.conversion_actions';
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const words = (value: string) => { const text = value.toLowerCase().replace(/_/g, ' '); return text.charAt(0).toUpperCase() + text.slice(1); };
const standardLabel = (row: { category: string; origin: string }) => `${words(row.category)} · ${words(row.origin)}`;
/** A clean Google Ads rejection (4xx with GoogleAdsFailure details) proves nothing was applied; anything else after sending is ambiguous. */
const nativeRejection = (error: unknown) => {
  const body = error instanceof AdportError ? object(object(error.details).error) : {};
  return typeof body.code === 'number' && body.code >= 400 && body.code < 500 && Array.isArray(body.details) && body.details.some(detail => Array.isArray(object(detail).errors) && (object(detail).errors as unknown[]).length > 0);
};
const chunks = <T>(values: T[], size: number) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, index * size + size));
export const GOOGLE_CONVERSION_GOAL_WRITES = new Set(['google_create_custom_conversion_goal', 'google_set_campaign_conversion_goal']);

/**
 * Native v25 protos googleapis@97f6460c (custom_conversion_goal, conversion_goal_campaign_config,
 * campaign_conversion_goal, google_ads_service); campaign/custom goal guides checked 2026-11-25.
 * The per-service mutate requests have no partial_failure field, so writes use atomic googleAds:mutate.
 */
export class GoogleConversionGoalService {
  constructor(private readonly client: GoogleAdsRestClient, private readonly conversions: GoogleConversionService) {}

  /** Goals are owned by the selected customer or, with cross-account tracking, its conversion customer. */
  private owners(account: string, conversionCustomer: string | null) { return new Set([account, ...(conversionCustomer ? [conversionCustomer.slice('customers/'.length)] : [])]); }

  private goal(value: unknown, owners: Set<string>): Goal {
    const row = object(value), match = typeof row.resourceName === 'string' ? row.resourceName.match(/^customers\/(\d{10})\/customConversionGoals\/([1-9]\d*)$/) : null;
    const actions = row.conversionActions === undefined ? [] : row.conversionActions;
    if (!match || !owners.has(match[1]!) || row.id !== match[2] || typeof row.name !== 'string' || !['ENABLED', 'REMOVED'].includes(String(row.status)) || !Array.isArray(actions) || actions.some(item => typeof item !== 'string' || !/^customers\/\d{10}\/conversionActions\/[1-9]\d*$/.test(item))) throw new AdportError('PROVIDER_ERROR', 'google: custom conversion goal response has an invalid identity, status or action list');
    // Sorted so an API reorder of the same actions keeps expected_goal_hash valid.
    return { resourceName: row.resourceName as string, id: row.id as string, name: row.name, status: String(row.status), conversionActions: [...actions as string[]].sort() };
  }

  private goalView(goal: Goal, actions: Map<string, Row>) {
    return { custom_conversion_goal_id: goal.id, resource_name: goal.resourceName, name: goal.name, status: goal.status, conversion_actions: goal.conversionActions.map(resource => { const action = actions.get(resource); return { conversion_action_id: resource.split('/').at(-1)!, resource_name: resource, name: typeof action?.name === 'string' ? action.name : null, ...(action ? { status: action.status, category: action.category } : {}) }; }), snapshot_hash: digest(goal) };
  }

  /** Resolves action resource names to native actions; unreturned resources stay unresolved. */
  private async actions(account: string, resources: string[]) {
    const found = new Map<string, Row>(), ids = [...new Set(resources.map(resource => resource.split('/').at(-1)!))];
    for (const batch of chunks(ids, 100)) {
      const rows = await this.client.search(account, `SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.category, conversion_action.type FROM conversion_action WHERE conversion_action.id IN (${batch.join(',')}) LIMIT ${batch.length * 2 + 1}`, { maxRows: batch.length * 2 + 1 });
      for (const raw of rows) {
        const action = object(raw.conversionAction);
        if (typeof action.resourceName !== 'string' || !batch.includes(String(action.id)) || action.resourceName.split('/').at(-1) !== action.id || found.has(action.resourceName)) throw new AdportError('PROVIDER_ERROR', 'google: conversion action lookup returned an unexpected identity');
        found.set(action.resourceName, action);
      }
    }
    return found;
  }

  /** Lists custom goals; with campaign_ids, also the goal state of those campaigns and the snapshot that binds google_set_campaign_conversion_goal. */
  async list(input: { account_id: string; after_goal_id?: string; include_removed?: boolean; limit: number; campaign_ids?: string[] }) {
    const account = normalizeCustomerId(input.account_id), context = await this.conversions.context(account), owners = this.owners(account, context.conversion_customer);
    if (input.after_goal_id) id.parse(input.after_goal_id);
    const predicates = [...(!input.include_removed ? ["custom_conversion_goal.status != 'REMOVED'"] : []), ...(input.after_goal_id ? [`custom_conversion_goal.id > ${input.after_goal_id}`] : [])];
    const rows = await this.client.search(account, `SELECT ${goalFields} FROM custom_conversion_goal${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''} ORDER BY custom_conversion_goal.id ASC LIMIT ${input.limit + 1}`, { maxRows: input.limit + 1 });
    const goals = rows.map(row => this.goal(row.customConversionGoal, owners));
    if (goals.some((goal, index) => BigInt(goal.id) <= BigInt(index ? goals[index - 1]!.id : input.after_goal_id ?? '0'))) throw new AdportError('PROVIDER_ERROR', 'google: custom conversion goal continuation did not advance');
    const page = goals.slice(0, input.limit), truncated = goals.length > input.limit;
    const selected = input.campaign_ids ? campaignIds.parse(input.campaign_ids) : null, current = selected ? await this.campaignContext(account, selected, owners) : null;
    const referenced = current ? await this.referencedGoals(account, owners, [...current.campaigns.values()]) : new Map<string, Goal>();
    const actions = await this.actions(account, [...page, ...referenced.values()].flatMap(goal => goal.conversionActions));
    return { conversion_customer: context.conversion_customer, goals: page.map(goal => this.goalView(goal, actions)), truncated, ...(truncated ? { next_cursor: page.at(-1)!.id } : {}), ...(selected && current ? { campaigns: selected.map(campaignId => this.campaignView(current.campaigns.get(campaignId)!, referenced, actions)), snapshot_hash: current.snapshot_hash } : {}) };
  }

  private async goalById(account: string, owners: Set<string>, goalId: string) {
    id.parse(goalId);
    const rows = await this.client.search(account, `SELECT ${goalFields} FROM custom_conversion_goal WHERE custom_conversion_goal.id = ${goalId} LIMIT 2`, { maxRows: 2 });
    if (rows.length !== 1) throw new AdportError('INVALID_INPUT', 'google: custom conversion goal was not returned by the selected account. Google lists the conversion customer\'s goals from client accounts, but a goal it does not return cannot be verified here; check the goal in Google Ads or select the account that owns it');
    const goal = this.goal(rows[0]!.customConversionGoal, owners);
    if (goal.id !== goalId) throw new AdportError('PROVIDER_ERROR', 'google: custom conversion goal ID mismatch');
    return goal;
  }

  private async checkedGoal(account: string, owners: Set<string>, input: { custom_conversion_goal_id: string; expected_goal_hash: string }) {
    const goal = await this.goalById(account, owners, input.custom_conversion_goal_id);
    if (digest(goal) !== input.expected_goal_hash) throw new AdportError('PENDING_MISMATCH', 'google: custom conversion goal changed; read google_custom_conversion_goals again and request a fresh preview');
    return goal;
  }

  /** Reads exactly the requested campaigns, their goal configuration and standard (category/origin) goals. */
  private async campaignContext(account: string, ids: string[], owners: Set<string>) {
    const list = ids.join(','), bound = ids.length * 200;
    const campaigns = await this.client.search(account, `SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.id IN (${list}) LIMIT ${ids.length + 1}`, { maxRows: ids.length + 1 });
    const byId = new Map<string, CampaignGoals>();
    for (const raw of campaigns) {
      const campaign = object(raw.campaign), campaignId = String(campaign.id);
      if (!ids.includes(campaignId) || campaign.resourceName !== `customers/${account}/campaigns/${campaignId}` || byId.has(campaignId) || !['ENABLED', 'PAUSED'].includes(String(campaign.status))) throw new AdportError('INVALID_INPUT', 'google: every campaign must be an enabled or paused campaign in the selected account');
      byId.set(campaignId, { campaign, config: { resourceName: '', level: 'CUSTOMER', goal: null }, standard: [] });
    }
    if (byId.size !== ids.length) throw new AdportError('INVALID_INPUT', `google: campaigns not found in the selected account: ${ids.filter(value => !byId.has(value)).join(', ')}`);
    const configs = await this.client.search(account, `SELECT conversion_goal_campaign_config.resource_name, conversion_goal_campaign_config.campaign, conversion_goal_campaign_config.goal_config_level, conversion_goal_campaign_config.custom_conversion_goal, campaign.id FROM conversion_goal_campaign_config WHERE campaign.id IN (${list}) LIMIT ${ids.length + 1}`, { maxRows: ids.length + 1 });
    const configured = new Set<string>();
    for (const raw of configs) {
      const config = object(raw.conversionGoalCampaignConfig), campaignId = String(object(raw.campaign).id), entry = byId.get(campaignId), goal = config.customConversionGoal;
      const goalOwner = typeof goal === 'string' ? goal.match(/^customers\/(\d{10})\/customConversionGoals\/[1-9]\d*$/)?.[1] : undefined;
      if (!entry || configured.has(campaignId) || config.resourceName !== `customers/${account}/conversionGoalCampaignConfigs/${campaignId}` || config.campaign !== entry.campaign.resourceName || !['CUSTOMER', 'CAMPAIGN'].includes(String(config.goalConfigLevel)) || (goal !== undefined && goal !== '' && (!goalOwner || !owners.has(goalOwner)))) throw new AdportError('PROVIDER_ERROR', 'google: campaign goal configuration has an invalid identity, level or custom goal');
      configured.add(campaignId);
      entry.config = { resourceName: config.resourceName as string, level: config.goalConfigLevel as 'CUSTOMER' | 'CAMPAIGN', goal: typeof goal === 'string' && goal ? goal : null };
    }
    if (configured.size !== ids.length) throw new AdportError('PROVIDER_ERROR', 'google: a campaign goal configuration was not returned');
    const standards = await this.client.search(account, `SELECT campaign_conversion_goal.resource_name, campaign_conversion_goal.campaign, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable, campaign.id FROM campaign_conversion_goal WHERE campaign.id IN (${list}) LIMIT ${bound + 1}`, { maxRows: bound + 1 });
    if (standards.length > bound) throw new AdportError('PROVIDER_ERROR', 'google: campaign goals exceed the 200-per-campaign safety bound');
    for (const raw of standards) {
      const row = object(raw.campaignConversionGoal), campaignId = String(object(raw.campaign).id), entry = byId.get(campaignId);
      if (!entry || row.campaign !== entry.campaign.resourceName || typeof row.category !== 'string' || !ORIGINS.includes(row.origin as typeof ORIGINS[number]) || row.resourceName !== `customers/${account}/campaignConversionGoals/${campaignId}~${row.category}~${row.origin}` || entry.standard.some(item => item.resourceName === row.resourceName)) throw new AdportError('PROVIDER_ERROR', 'google: campaign conversion goal has an invalid identity, category or origin');
      entry.standard.push({ resourceName: row.resourceName, category: row.category, origin: String(row.origin), biddable: row.biddable === true });
    }
    for (const entry of byId.values()) entry.standard.sort((a, b) => a.resourceName.localeCompare(b.resourceName));
    const ordered = [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).map(value => byId.get(value)!);
    return { campaigns: byId, snapshot_hash: digest({ account, campaigns: ordered.map(entry => ({ id: entry.campaign.id, config: entry.config, standard: entry.standard })) }) };
  }

  private describe(state: { level: string; goal: Goal | null; goalResource: string | null; standard: Array<{ category: string; origin: string; biddable: boolean }> }, actions: Map<string, Row>) {
    const bidding = state.standard.filter(row => row.biddable).map(standardLabel);
    if (state.level === 'CUSTOMER') return `Account default goals${bidding.length ? ` (${bidding.join(', ')})` : ''}`;
    const parts = [];
    if (state.goal) parts.push(`custom goal "${state.goal.name}" optimizing for ${state.goal.conversionActions.map(resource => { const name = actions.get(resource)?.name; return typeof name === 'string' ? `"${name}"` : `action ${resource.split('/').at(-1)}`; }).join(', ') || 'no actions'}`);
    else if (state.goalResource) parts.push(`custom goal ${state.goalResource.split('/').at(-1)}`);
    parts.push(bidding.length ? `standard goals used for bidding: ${bidding.join(', ')}` : 'no standard goals used for bidding');
    return `Campaign-specific goals: ${parts.join('; ')}`;
  }

  private campaignView(entry: CampaignGoals, goals: Map<string, Goal>, actions: Map<string, Row>) {
    const goal = entry.config.goal ? goals.get(entry.config.goal) ?? null : null;
    return { campaign_id: String(entry.campaign.id), name: entry.campaign.name, status: entry.campaign.status, channel_type: entry.campaign.advertisingChannelType, goal_config_level: entry.config.level, custom_conversion_goal: entry.config.level === 'CAMPAIGN' && entry.config.goal ? (goal ? this.goalView(goal, actions) : { resource_name: entry.config.goal }) : null, standard_goals: entry.standard.map(row => ({ category: row.category, origin: row.origin, biddable: row.biddable })), summary: this.describe({ level: entry.config.level, goal, goalResource: entry.config.goal, standard: entry.standard }, actions) };
  }

  private async referencedGoals(account: string, owners: Set<string>, entries: CampaignGoals[]) {
    const resources = [...new Set(entries.filter(entry => entry.config.level === 'CAMPAIGN' && entry.config.goal).map(entry => entry.config.goal!))], found = new Map<string, Goal>();
    for (const batch of chunks(resources.map(resource => resource.split('/').at(-1)!), 100)) {
      const rows = await this.client.search(account, `SELECT ${goalFields} FROM custom_conversion_goal WHERE custom_conversion_goal.id IN (${batch.join(',')}) LIMIT ${batch.length * 2 + 1}`, { maxRows: batch.length * 2 + 1 });
      for (const row of rows) { const goal = this.goal(row.customConversionGoal, owners); if (resources.includes(goal.resourceName)) found.set(goal.resourceName, goal); }
    }
    return found;
  }

  /** Every referenced action must be an enabled action visible from the selected customer. */
  private async enabledActions(account: string, owners: Set<string>, ids: string[]) {
    const found = new Map<string, Row>();
    for (const batch of chunks(ids, 100)) {
      const rows = await this.client.search(account, `SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.category FROM conversion_action WHERE conversion_action.id IN (${batch.join(',')}) LIMIT ${batch.length + 1}`, { maxRows: batch.length + 1 });
      for (const raw of rows) {
        const action = object(raw.conversionAction), match = typeof action.resourceName === 'string' ? action.resourceName.match(/^customers\/(\d{10})\/conversionActions\/([1-9]\d*)$/) : null;
        if (!match || !owners.has(match[1]!) || match[2] !== action.id || !batch.includes(match[2]!) || found.has(match[2]!)) throw new AdportError('PROVIDER_ERROR', 'google: conversion action lookup returned an unexpected identity');
        if (action.status !== 'ENABLED') throw new AdportError('INVALID_INPUT', `google: conversion action ${match[2]} is ${String(action.status)}; custom goals need enabled actions`);
        found.set(match[2]!, action);
      }
    }
    const missing = ids.filter(value => !found.has(value));
    if (missing.length) throw new AdportError('INVALID_INPUT', `google: conversion actions not found in the selected account or its conversion customer: ${missing.join(', ')}`);
    return ids.map(value => found.get(value)!);
  }

  async plan(op: WriteOperation): Promise<Plan> {
    const kind = op.tool === 'google_create_custom_conversion_goal' ? 'create' : 'update';
    if (op.provider !== 'google' || !GOOGLE_CONVERSION_GOAL_WRITES.has(op.tool) || op.kind !== kind) throw new AdportError('INVALID_INPUT', 'google: conversion goal operation kind mismatch');
    const account = normalizeCustomerId(op.accountId), context = await this.conversions.context(account), owners = this.owners(account, context.conversion_customer);
    if (op.tool === 'google_set_campaign_conversion_goal') return this.planCampaigns(account, owners, setGoal.parse(op.payload));
    if (context.conversion_customer && context.conversion_customer !== `customers/${account}`) throw new AdportError('INVALID_INPUT', `google: custom conversion goals are managed in the conversion customer ${context.conversion_customer}; select that explicitly authorized account to change them`);
    const input = createGoal.parse(op.payload), actions = await this.enabledActions(account, owners, input.conversion_action_ids);
    const operations = [{ customConversionGoalOperation: { create: { name: input.name, conversionActions: actions.map(action => action.resourceName) } } }];
    const fields: ReviewField[] = [{ label: 'Goal name', before: '(new)', after: input.name }, { label: 'Optimizes for', before: '(new)', after: actions.map(action => `${String(action.name)} [${String(action.id)}]`) }];
    const notes = ['A custom goal makes its actions biddable for every campaign that uses it, whether or not each action is primary_for_goal.', 'Creating a goal does not attach it to any campaign; use google_set_campaign_conversion_goal.'];
    return { summary: `Create Google custom conversion goal "${input.name}"`, changes: fields.map(field => `${field.label}: ${JSON.stringify(field.before)} → ${JSON.stringify(field.after)}`), fieldChanges: fields.map(field => ({ field: field.label, before: JSON.stringify(field.before), after: JSON.stringify(field.after) })), coercions: [], budgetDeltas: [], notes, review: { provider: 'google', accountId: account, kind: op.kind, title: 'Create custom conversion goal', fields, notices: notes }, execute: async validateOnly => {
      const result = await this.client.googleAdsMutate(account, operations, { validateOnly });
      if (validateOnly) return [];
      const responses = result?.mutateOperationResponses, resource = Array.isArray(responses) && responses.length === 1 ? responses[0]?.customConversionGoalResult?.resourceName : undefined;
      if (typeof resource !== 'string' || !new RegExp(`^customers/${account}/customConversionGoals/[1-9]\\d*$`).test(resource)) throw new AdportError('PROVIDER_ERROR', 'google: custom conversion goal mutation receipt mismatch; reconcile before retrying', { resource_ids: typeof resource === 'string' ? [resource] : [] });
      return [resource];
    } };
  }

  private async planCampaigns(account: string, owners: Set<string>, input: z.infer<typeof setGoal>): Promise<Plan> {
    const before = await this.campaignContext(account, input.campaign_ids, owners);
    if (before.snapshot_hash !== input.expected_snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'google: campaign goal configuration changed; read google_custom_conversion_goals with the same campaign_ids and preview again');
    const entries = input.campaign_ids.map(campaignId => before.campaigns.get(campaignId)!);
    const target = input.goal?.type === 'CUSTOM_GOAL' ? await this.checkedGoal(account, owners, input.goal) : null;
    if (target && target.status !== 'ENABLED') throw new AdportError('INVALID_INPUT', 'google: the selected custom conversion goal has been removed');
    const goals = await this.referencedGoals(account, owners, entries);
    if (target) goals.set(target.resourceName, target);
    const actions = await this.actions(account, [...goals.values()].flatMap(goal => goal.conversionActions));
    const toggles = Array.isArray(input.standard_goals) ? input.standard_goals : [];
    const configOps: Row[] = [], standardOps: Row[] = [], fields: ReviewField[] = [], expectations: Array<{ campaignId: string; level: 'CUSTOMER' | 'CAMPAIGN'; goal?: string; biddable: Map<string, boolean> }> = [], warnings: string[] = [];
    for (const entry of entries) {
      const campaignId = String(entry.campaign.id), name = String(entry.campaign.name), currentGoal = entry.config.level === 'CAMPAIGN' ? entry.config.goal : null;
      let level = entry.config.level, goalResource = currentGoal;
      if (input.goal?.type === 'ACCOUNT_DEFAULT') {
        if (entry.config.level !== 'CUSTOMER') configOps.push({ conversionGoalCampaignConfigOperation: { update: { resourceName: entry.config.resourceName, goalConfigLevel: 'CUSTOMER' }, updateMask: 'goal_config_level' } });
        level = 'CUSTOMER'; goalResource = null;
      } else if (target) {
        // Explicit level switch: the campaign-goals guide documents an implicit backend switch, but we do not rely on it.
        if (entry.config.level !== 'CAMPAIGN') configOps.push({ conversionGoalCampaignConfigOperation: { update: { resourceName: entry.config.resourceName, goalConfigLevel: 'CAMPAIGN', customConversionGoal: target.resourceName }, updateMask: 'goal_config_level,custom_conversion_goal' } });
        else if (currentGoal !== target.resourceName) configOps.push({ conversionGoalCampaignConfigOperation: { update: { resourceName: entry.config.resourceName, customConversionGoal: target.resourceName }, updateMask: 'custom_conversion_goal' } });
        level = 'CAMPAIGN'; goalResource = target.resourceName;
      } else if (input.standard_goals && entry.config.level !== 'CAMPAIGN') {
        // Standard-goal toggles only: switch the level first, in the same atomic request.
        configOps.push({ conversionGoalCampaignConfigOperation: { update: { resourceName: entry.config.resourceName, goalConfigLevel: 'CAMPAIGN' }, updateMask: 'goal_config_level' } });
      }
      const biddable = new Map<string, boolean>(), standardAfter = entry.standard.map(row => ({ ...row }));
      if (input.standard_goals) {
        level = 'CAMPAIGN';
        const wanted = input.standard_goals === 'DISABLE_ALL' ? entry.standard.map(row => ({ category: row.category, origin: row.origin, biddable: false })) : toggles;
        for (const item of wanted) {
          const row = standardAfter.find(value => value.category === item.category && value.origin === item.origin);
          if (!row) throw new AdportError('INVALID_INPUT', `google: campaign "${name}" [${campaignId}] has no ${item.category}/${item.origin} goal; read google_custom_conversion_goals with campaign_ids for the available pairs`);
          biddable.set(row.resourceName, item.biddable);
          if (row.biddable !== item.biddable) { standardOps.push({ campaignConversionGoalOperation: { update: { resourceName: row.resourceName, biddable: item.biddable }, updateMask: 'biddable' } }); row.biddable = item.biddable; }
        }
      }
      const beforeText = this.describe({ level: entry.config.level, goal: currentGoal ? goals.get(currentGoal) ?? null : null, goalResource: currentGoal, standard: entry.standard }, actions);
      const afterText = level === 'CUSTOMER' ? 'Account default goals (campaign-specific and custom goals no longer apply)' : this.describe({ level, goal: goalResource ? goals.get(goalResource) ?? null : null, goalResource, standard: standardAfter }, actions);
      fields.push({ label: `${name} [${campaignId}]`, before: beforeText, after: beforeText === afterText && level === entry.config.level ? 'No change' : afterText });
      if (target && level === 'CAMPAIGN' && standardAfter.some(row => row.biddable)) warnings.push(`${name} [${campaignId}] also keeps bidding on ${standardAfter.filter(row => row.biddable).map(standardLabel).join(', ')}. Pass standard_goals="DISABLE_ALL" to optimize only for the custom goal.`);
      expectations.push({ campaignId, level, ...(goalResource ? { goal: goalResource } : {}), biddable });
    }
    const operations = [...configOps, ...standardOps];
    if (!operations.length) throw new AdportError('INVALID_INPUT', 'google: every selected campaign already has this conversion goal configuration');
    if (operations.length > 5000) throw new AdportError('INVALID_INPUT', 'google: conversion goal edits exceed the 5,000-operation tool bound; select fewer campaigns');
    const changed = fields.filter(field => field.after !== 'No change').length;
    const notes = [...warnings, 'All campaigns change in one atomic request: either every listed change applies or none does.', 'Campaign-specific goals stop following future account-level goal changes until the campaign is set back to ACCOUNT_DEFAULT.', 'Conversion goals change what automated bidding optimizes for and what the Conversions column reports. Campaign statuses and budgets are not changed.'];
    const summary = target ? `Use custom conversion goal "${target.name}" on ${changed} Google campaign${changed === 1 ? '' : 's'}` : input.goal?.type === 'ACCOUNT_DEFAULT' ? `Restore account default conversion goals on ${changed} Google campaign${changed === 1 ? '' : 's'}` : `Update standard conversion goals on ${changed} Google campaign${changed === 1 ? '' : 's'}`;
    let details: unknown;
    return { summary, changes: fields.map(field => `${field.label}: ${String(field.before)} → ${String(field.after)}`), fieldChanges: fields.map(field => ({ field: field.label, before: String(field.before), after: String(field.after) })), coercions: [], budgetDeltas: [], notes, review: { provider: 'google', accountId: account, kind: 'update', title: 'Set campaign conversion goals', ...(target ? { subject: target.name } : {}), fields, notices: notes }, resultDetails: () => details, execute: async validateOnly => {
      const known = new Set<string>();
      const unconfirmed = () => new AdportError('PROVIDER_ERROR', 'google: campaign conversion goal outcome was not confirmed. Read google_custom_conversion_goals with campaign_ids before another change; no write was retried.', { resourceIds: [...known] });
      let result: Awaited<ReturnType<GoogleAdsRestClient['googleAdsMutate']>>;
      try {
        result = await this.client.googleAdsMutate(account, operations, { validateOnly });
      } catch (error) {
        // A clean native rejection means nothing was applied; a transport failure after sending is ambiguous.
        if (validateOnly || nativeRejection(error)) throw error;
        throw unconfirmed();
      }
      try {
        if (!result || typeof result !== 'object' || Array.isArray(result) || 'partialFailureError' in result) throw new AdportError('PROVIDER_ERROR', 'google: conversion goal mutate response envelope could not be verified');
        if (validateOnly) return [];
        const responses = result.mutateOperationResponses;
        if (!Array.isArray(responses) || responses.length !== operations.length) throw new Error('receipt count mismatch');
        responses.forEach((response, index) => {
          const operation = operations[index]!, key = operation.conversionGoalCampaignConfigOperation ? 'conversionGoalCampaignConfig' : 'campaignConversionGoal', expected = object(object(operation[`${key}Operation`]).update).resourceName;
          if (Object.keys(object(response)).length !== 1 || response[`${key}Result`]?.resourceName !== expected) throw new Error('receipt mismatch');
          known.add(String(expected));
        });
        const after = await this.campaignContext(account, input.campaign_ids, owners);
        for (const expectation of expectations) {
          const observed = after.campaigns.get(expectation.campaignId)!;
          if (observed.config.level !== expectation.level || (expectation.goal && observed.config.goal !== expectation.goal) || [...expectation.biddable].some(([resource, value]) => observed.standard.find(row => row.resourceName === resource)?.biddable !== value)) throw new Error('readback mismatch');
        }
        details = { snapshot_hash: after.snapshot_hash, campaigns_changed: changed, operations: operations.length, readback_verified: true };
        return [...known];
      } catch (error) {
        if (validateOnly) throw error;
        throw unconfirmed();
      }
    } };
  }
}

export function googleConversionGoalTools(provider: GoogleAdsProvider): AnyToolDefinition[] {
  const write = (name: string, description: string, payload: z.ZodObject, kind: 'create' | 'update') => guardedWriteTool({ name, namespace: 'google', provider: 'google', description, payload, kind });
  return [
    defineTool({ name: 'google_custom_conversion_goals', namespace: 'google', description: 'List custom conversion goals and their actions, as returned by the selected account (with cross-account tracking Google includes the conversion customer\'s goals; a goal it does not return shows only as resource_name and cannot be assigned here); each snapshot_hash is the expected_goal_hash. With campaign_ids (up to 50), also returns those campaigns\' goal state and the snapshot_hash for google_set_campaign_conversion_goal. Continue next_cursor as after_goal_id.', input: z.object({ account_id: z.string(), campaign_ids: campaignIds.optional(), after_goal_id: id.optional(), include_removed: z.boolean().default(false), limit: z.number().int().positive().max(200).default(50) }), output: z.object({ conversion_customer: z.string().nullable(), goals: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean(), next_cursor: id.optional(), campaigns: z.array(z.record(z.string(), z.unknown())).optional(), snapshot_hash: hash.optional() }), annotations: { readOnly: true }, pagination: { cursorInput: 'after_goal_id' }, handler: input => provider.conversionGoals.list(input) }),
    write('google_create_custom_conversion_goal', 'Create a custom conversion goal from 1–100 enabled conversion action IDs in the conversion-tracking account. Attaches to no campaign.', createGoal, 'create'),
    write('google_set_campaign_conversion_goal', 'Set the conversion goal of 1–50 campaigns atomically. goal: CUSTOM_GOAL or ACCOUNT_DEFAULT. standard_goals: "DISABLE_ALL" (optimize only for the custom goal) or category/origin biddable toggles.', setGoal, 'update'),
  ];
}
