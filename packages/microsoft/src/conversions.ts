import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteGuard, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { MicrosoftNativeService, microsoftId as id, microsoftNativeId as nativeId, microsoftRows as rows, type MicrosoftPlan, type MicrosoftRow as Row } from './native.js';
import type { MicrosoftAdsProvider } from './provider.js';

const goalType = z.enum(['AppDownload', 'AppInstall', 'Duration', 'Event', 'InStoreTransaction', 'OfflineConversion', 'PagesViewedPerVisit', 'Url']);
const supportedType = z.enum(['Url', 'Event', 'OfflineConversion']);
const standardTypes = ['AppDownload', 'AppInstall', 'Duration', 'Event', 'OfflineConversion', 'PagesViewedPerVisit', 'Url'] as const;
const name = z.string().min(1).max(100).refine(value => value.trim().length > 0, 'Name cannot be blank');
const category = z.enum(['AddToCart', 'BeginCheckout', 'BookAppointment', 'Contact', 'GetDirections', 'Other', 'OutboundClick', 'PageView', 'Purchase', 'RequestQuote', 'Signup', 'SubmitLeadForm', 'Subscribe']);
const expression = z.object({ operator: z.enum(['BeginsWith', 'Contains', 'Equals', 'RegularExpression']), text: z.string().min(1).max(100) });
const event = z.object({ action: expression.optional(), category: expression.optional(), label: expression.optional(), value: z.object({ operator: z.enum(['Equals', 'GreaterThan', 'LessThan']), amount: z.number() }).optional() }).refine(value => Object.values(value).some(value => value !== undefined), 'At least one complete event condition is required');
const url = z.object({ operator: expression.shape.operator, expression: z.string().min(1).max(1000) });
const revenue = z.discriminatedUnion('type', [z.object({ type: z.literal('NoValue') }), z.object({ type: z.literal('FixedValue'), value: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/).optional() }), z.object({ type: z.literal('VariableValue'), value: z.number().nonnegative().optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() })]);
const common = z.object({ name, goal_category: category, status: z.enum(['Active', 'Paused']).default('Paused'), exclude_from_bidding: z.boolean().default(true), count_type: z.enum(['All', 'Unique']).default('All'), conversion_window_minutes: z.number().int().min(1).max(129600).default(43200), revenue: revenue.default({ type: 'NoValue' }), expected_auto_tagging_enabled: z.boolean() });
const create = z.object({ goal: z.discriminatedUnion('type', [common.extend({ type: z.literal('OfflineConversion'), is_externally_attributed: z.boolean().default(false) }), common.extend({ type: z.literal('Url'), tag_id: id, url_rule: url }), common.extend({ type: z.literal('Event'), tag_id: id, event_conditions: event })]) });
const update = z.object({ goal_id: id, goal_type: supportedType, expected_snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/), name: name.optional(), goal_category: category.optional(), status: z.enum(['Active', 'Paused']).optional(), exclude_from_bidding: z.boolean().optional(), count_type: z.enum(['All', 'Unique']).optional(), conversion_window_minutes: z.number().int().min(1).max(129600).optional(), revenue: revenue.optional(), is_externally_attributed: z.boolean().optional(), url_rule: url.optional(), event_conditions: event.optional() }).refine(value => Object.entries(value).some(([key, value]) => !['goal_id', 'goal_type', 'expected_snapshot_hash'].includes(key) && value !== undefined), 'Supply an editable field');
const view = z.object({ goal: z.record(z.string(), z.unknown()), auto_tagging_enabled: z.boolean(), snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/) });
const additional = 'GoalCategory, IsExternallyAttributed, IsAutoGoal, IsEnhancedConversionsEnabled, ViewThroughConversionWindowInMinutes, AttributionModelType';
const pairs = [['ActionExpression', 'ActionOperator', 'action'], ['CategoryExpression', 'CategoryOperator', 'category'], ['LabelExpression', 'LabelOperator', 'label'], ['Value', 'ValueOperator', 'value']] as const;
const notes = ['Microsoft automatically enables MSCLKIDAutoTaggingEnabled when adding or updating this goal, including paused goals. This tool does not install a UET tag or send conversion events.', 'Account scope is fixed. Native Deleted status is internal-only; no permanent goal-deletion operation is exposed. Use Paused to stop tracking.', 'Goal snapshots detect changed configuration before submission; Microsoft provides no atomic compare-and-set. Conversion settings can affect reporting and automated bidding.'];
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : value; }
const wireRevenue = (value: z.infer<typeof revenue>) => ({ Type: value.type, ...('value' in value && value.value !== undefined ? { Value: value.value } : {}), ...('currency' in value && value.currency ? { CurrencyCode: value.currency } : {}) });
function eventFields(value: z.infer<typeof event>): Row {
  const fields: Row = {};
  for (const [field, operator, key] of pairs) { const condition = value[key]; fields[field] = condition ? 'text' in condition ? condition.text : condition.amount : null; fields[operator] = condition?.operator ?? null; }
  return fields;
}
function matches(actual: Row, fields: Row): boolean {
  return Object.entries(fields).every(([key, value]) => value === null ? actual[key] === null || actual[key] === undefined : value && typeof value === 'object' && !Array.isArray(value) ? actual[key] && typeof actual[key] === 'object' && matches(actual[key] as Row, value as Row) : String(actual[key]) === String(value));
}
export const MICROSOFT_CONVERSION_WRITES = new Set(['microsoft_create_conversion_goal', 'microsoft_update_conversion_goal']);

/** Campaign Management v13; EventGoal omissions delete criteria, unlike ordinary optional update fields. */
export class MicrosoftConversionService extends MicrosoftNativeService {
  private async autoTagging(account: string): Promise<boolean> {
    const result = await this.request(account, 'AccountProperties/Query', { AccountPropertyNames: ['MSCLKIDAutoTaggingEnabled'] });
    const properties = rows(result.AccountProperties).filter(value => value.Name === 'MSCLKIDAutoTaggingEnabled');
    if (properties.length !== 1 || !['true', 'false'].includes(String(properties[0]!.Value))) throw new AdportError('PROVIDER_ERROR', 'microsoft: native click-ID auto-tagging state is unavailable');
    return String(properties[0]!.Value) === 'true';
  }

  private async query(account: string, types: z.infer<typeof goalType>[]): Promise<Row[]> {
    const result = await this.request(account, 'ConversionGoals/QueryByIds', { ConversionGoalIds: null, ConversionGoalTypes: types.join(', '), ReturnAdditionalFields: additional });
    if (!Object.hasOwn(result, 'ConversionGoals')) throw new AdportError('PROVIDER_ERROR', 'microsoft: conversion goals response envelope is missing');
    const values = rows(result.ConversionGoals);
    if (new Set(values.map(value => nativeId(value.Id))).size !== values.length || values.some(value => !types.includes(goalType.parse(value.Type)))) throw new AdportError('PROVIDER_ERROR', 'microsoft: conversion-goal native identities or types mismatch');
    return values;
  }

  private snapshot(account: string, goal: Row, enabled: boolean) {
    const { TrackingStatus: _tracking, ...configuration } = goal;
    return { goal, auto_tagging_enabled: enabled, snapshot_hash: createHash('sha256').update(JSON.stringify(canonical({ account, configuration, enabled }))).digest('hex') };
  }

  async list(input: { account_id: string; goal_types: z.infer<typeof goalType>[]; after_goal_id?: string; limit: number }) {
    const values = await this.query(input.account_id, input.goal_types), enabled = await this.autoTagging(input.account_id), remaining = values.filter(value => !input.after_goal_id || BigInt(nativeId(value.Id)) > BigInt(input.after_goal_id)).sort((a, b) => BigInt(nativeId(a.Id)) < BigInt(nativeId(b.Id)) ? -1 : 1), page = remaining.slice(0, input.limit), truncated = remaining.length > page.length;
    return { rows: page.map(value => this.snapshot(input.account_id, value, enabled)), auto_tagging_enabled: enabled, truncated, ...(truncated ? { next_cursor: nativeId(page.at(-1)!.Id) } : {}) };
  }

  async get(account: string, goalId: string, type: z.infer<typeof goalType>) {
    id.parse(goalId); const values = await this.query(account, [type]), enabled = await this.autoTagging(account), current = values.find(value => nativeId(value.Id) === goalId);
    if (!current) throw new AdportError('INVALID_INPUT', 'microsoft: conversion goal was not found for the selected account/type');
    return this.snapshot(account, current, enabled);
  }

  private async tag(account: string, tagId: string): Promise<void> {
    const result = await this.request(account, 'UetTags/QueryByIds', { TagIds: [tagId] });
    const values = rows(result.UetTags);
    if (values.length !== 1 || nativeId(values[0]!.Id) !== tagId) throw new AdportError('INVALID_INPUT', 'microsoft: UET tag is unavailable in the selected native customer/account context');
  }

  private async verify(account: string, goalId: string, type: z.infer<typeof supportedType>, expected: Row): Promise<string[]> {
    try { const current = await this.get(account, goalId, type); if (current.goal.Scope !== 'Account' || !current.auto_tagging_enabled || !matches(current.goal, expected)) throw new Error('Goal readback mismatch'); }
    catch { throw new AdportError('PROVIDER_ERROR', 'microsoft: conversion-goal write was accepted but readback was not confirmed; reconcile before retrying', { resourceIds: [goalId] }); }
    return [goalId];
  }

  async plan(op: WriteOperation, guard: WriteGuard): Promise<MicrosoftPlan> {
    if (op.provider !== 'microsoft' || !MICROSOFT_CONVERSION_WRITES.has(op.tool) || op.kind !== (op.tool === 'microsoft_create_conversion_goal' ? 'create' : 'update')) throw new AdportError('INVALID_INPUT', 'microsoft: conversion-goal operation kind mismatch');
    const account = op.accountId;
    if (op.tool === 'microsoft_create_conversion_goal') {
      const value = create.parse(op.payload).goal, enabled = await this.autoTagging(account);
      if (value.expected_auto_tagging_enabled !== enabled) throw new AdportError('INVALID_INPUT', 'microsoft: auto-tagging state changed; read fresh conversion context before previewing');
      const existing = await this.query(account, [...standardTypes]);
      if (existing.some(goal => typeof goal.Name === 'string' && goal.Name.toLowerCase() === value.name.toLowerCase())) throw new AdportError('INVALID_INPUT', 'microsoft: conversion goal name already exists; do not replay creation');
      if ('tag_id' in value) await this.tag(account, value.tag_id);
      const status = guard.forcePausedCreation ? 'Paused' : value.status;
      const fields: Row = { Type: value.type, Scope: 'Account', Name: value.name, Status: status, GoalCategory: value.goal_category, ExcludeFromBidding: value.exclude_from_bidding, CountType: value.count_type, ConversionWindowInMinutes: value.conversion_window_minutes, Revenue: wireRevenue(value.revenue), ...(value.type === 'OfflineConversion' ? { IsExternallyAttributed: value.is_externally_attributed } : { TagId: value.tag_id }), ...(value.type === 'Url' ? { UrlExpression: value.url_rule.expression, UrlOperator: value.url_rule.operator } : value.type === 'Event' ? eventFields(value.event_conditions) : {}) };
      return { summary: `Create Microsoft ${value.type} goal "${value.name}"`, changes: [`+ account-scoped conversion goal ${JSON.stringify(fields)}`, `MSCLKIDAutoTaggingEnabled ${enabled} → true (native side effect)`], fieldChanges: [{ field: 'Name', before: '(new)', after: value.name }, { field: 'Status', before: '(new)', after: status }, { field: 'MSCLKIDAutoTaggingEnabled', before: String(enabled), after: 'true' }], notes, coercions: status !== value.status ? ['Status coerced to Paused by policy (paused_creation)'] : [], budgetDeltas: [], execute: async () => {
        const result = await this.request(account, 'ConversionGoals', { ConversionGoals: [fields] });
        const ids = Array.isArray(result.ConversionGoalIds) ? result.ConversionGoalIds.filter(value => value !== null).map(nativeId) : [];
        if (ids.length !== 1 || existing.some(goal => nativeId(goal.Id) === ids[0])) throw new AdportError('PROVIDER_ERROR', 'microsoft: conversion-goal creation receipt mismatch; reconcile before retrying', { resourceIds: ids });
        return this.verify(account, ids[0]!, value.type, fields);
      } };
    }
    const value = update.parse(op.payload), current = await this.get(account, value.goal_id, value.goal_type);
    if (current.goal.Scope !== 'Account') throw new AdportError('INVALID_INPUT', 'microsoft: customer-wide conversion goals require authorization covering every affected account; single-account tools cannot mutate them');
    if (current.snapshot_hash !== value.expected_snapshot_hash) throw new AdportError('INVALID_INPUT', 'microsoft: conversion-goal snapshot changed; read fresh context and request a new preview');
    if (value.url_rule && value.goal_type !== 'Url' || value.event_conditions && value.goal_type !== 'Event' || value.is_externally_attributed !== undefined && value.goal_type !== 'OfflineConversion') throw new AdportError('INVALID_INPUT', 'microsoft: conversion-goal subtype fields mismatch');
    const fields: Row = {};
    for (const [key, field] of [['name', 'Name'], ['goal_category', 'GoalCategory'], ['status', 'Status'], ['exclude_from_bidding', 'ExcludeFromBidding'], ['count_type', 'CountType'], ['conversion_window_minutes', 'ConversionWindowInMinutes'], ['is_externally_attributed', 'IsExternallyAttributed']] as const) if (value[key] !== undefined && value[key] !== current.goal[field]) fields[field] = value[key];
    if (value.revenue) fields.Revenue = wireRevenue(value.revenue);
    if (value.url_rule) Object.assign(fields, { UrlExpression: value.url_rule.expression, UrlOperator: value.url_rule.operator });
    if (value.event_conditions) Object.assign(fields, eventFields(value.event_conditions));
    const changed = Object.entries(fields).filter(([key, value]) => !matches(current.goal, { [key]: value }));
    if (!changed.length) throw new AdportError('INVALID_INPUT', 'microsoft: conversion-goal update has no changes');
    // Native EventGoal updates delete any omitted criterion pair, even when only changing name/status.
    if (value.goal_type === 'Event' && !value.event_conditions) for (const [expression, operator] of pairs) {
      const expressionValue = current.goal[expression], operatorValue = current.goal[operator];
      if ((expressionValue === null || expressionValue === undefined) !== (operatorValue === null || operatorValue === undefined)) throw new AdportError('INVALID_INPUT', 'microsoft: existing event condition is incomplete; refusing a partial update');
      fields[expression] = expressionValue ?? null; fields[operator] = operatorValue ?? null;
    }
    const fieldChanges = changed.map(([field, after]) => ({ field, before: JSON.stringify(current.goal[field] ?? null), after: JSON.stringify(after) }));
    return { summary: `Update Microsoft ${value.goal_type} goal "${String(current.goal.Name)}"`, changes: [`~ goal ${value.goal_id} ${JSON.stringify(fields)}`, `MSCLKIDAutoTaggingEnabled ${current.auto_tagging_enabled} → true (native side effect)`], fieldChanges: [...fieldChanges, { field: 'MSCLKIDAutoTaggingEnabled', before: String(current.auto_tagging_enabled), after: 'true' }], notes, coercions: [], budgetDeltas: [], execute: async () => { await this.request(account, 'ConversionGoals', { ConversionGoals: [{ Id: value.goal_id, Type: value.goal_type, ...fields }] }, 'PUT'); return this.verify(account, value.goal_id, value.goal_type, { ...fields, Status: fields.Status ?? current.goal.Status }); } };
  }
}

export function microsoftConversionTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'microsoft_conversion_goals', namespace: 'microsoft', description: 'Read account-associated native goals, tracking state, configuration hashes and click-ID auto-tagging. Default excludes pilot-only InStoreTransaction, whose inclusion can reject the entire query. Continue next_cursor as after_goal_id.', input: z.object({ account_id: id, goal_types: z.array(goalType).min(1).refine(value => new Set(value).size === value.length, 'Goal types must be unique').default([...standardTypes]), after_goal_id: id.optional(), limit: z.number().int().positive().max(1000).default(100) }), output: z.object({ rows: z.array(view), auto_tagging_enabled: z.boolean(), truncated: z.boolean(), next_cursor: id.optional() }), pagination: { cursorInput: 'after_goal_id' }, annotations: { readOnly: true }, handler: input => provider.conversions.list(input) }),
    defineTool({ name: 'microsoft_get_conversion_goal', namespace: 'microsoft', description: 'Read one account-associated native goal and snapshot_hash. TrackingStatus is system-owned and excluded from the configuration hash. Customer-scoped goals cannot be edited through single-account tools.', input: z.object({ account_id: id, goal_id: id, goal_type: goalType }), output: view, annotations: { readOnly: true }, handler: input => provider.conversions.get(input.account_id, input.goal_id, input.goal_type) }),
    guardedWriteTool({ name: 'microsoft_create_conversion_goal', namespace: 'microsoft', provider: 'microsoft', kind: 'create', description: 'Create an account-scoped URL, Event or OfflineConversion goal. Defaults Paused and excluded from bidding. Native add automatically enables click-ID auto-tagging; supply its expected state from conversion-goal reads. Does not install tracking or send events. Goals cannot be permanently deleted through this API.', payload: create }),
    guardedWriteTool({ name: 'microsoft_update_conversion_goal', namespace: 'microsoft', provider: 'microsoft', kind: 'update', description: 'Edit an Account-scoped URL/Event/Offline goal with expected_snapshot_hash. Preserves omitted event criteria, status and other optional settings. Native update enables click-ID auto-tagging. Event conditions, when supplied, replace the full condition set. Use Paused to stop tracking; Deleted is internal-only.', payload: update }),
  ];
}
