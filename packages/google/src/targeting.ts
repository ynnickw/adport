import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type ReviewField, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import { GoogleAdsRestClient, normalizeCustomerId } from './client.js';
import type { GoogleAdsProvider } from './provider.js';
import { adSchedule, nativeTargetingCriterion, targetingList, targetingUpdate } from './targeting-schemas.js';

type Row = Record<string, unknown>;
type Criterion = z.infer<typeof nativeTargetingCriterion>;
type Schedule = z.infer<typeof adSchedule>;
interface Plan extends Omit<WritePreview, 'serverValidated'> { execute(validateOnly: boolean): Promise<string[]>; resultDetails(): unknown }
const BOUND = 20_000;
const fields = ['resource_name', 'criterion_id', 'campaign', 'type', 'status', 'negative', 'bid_modifier', 'location.geo_target_constant', 'language.language_constant', 'device.type', 'ad_schedule.day_of_week', 'ad_schedule.start_hour', 'ad_schedule.start_minute', 'ad_schedule.end_hour', 'ad_schedule.end_minute'].map(field => `campaign_criterion.${field}`);
const types = ['LOCATION', 'LANGUAGE', 'DEVICE', 'AD_SCHEDULE', 'LOCATION_GROUP', 'PROXIMITY'];
const infoFields: Partial<Record<Criterion['type'], 'location' | 'language' | 'device' | 'adSchedule'>> = { LOCATION: 'location', LANGUAGE: 'language', DEVICE: 'device', AD_SCHEDULE: 'adSchedule' };
const minuteWire = ['ZERO', 'FIFTEEN', 'THIRTY', 'FORTY_FIVE'] as const;
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
const float = (value: unknown) => typeof value === 'number' ? Math.fround(value) : value;
const comparable = (value: Criterion) => ({ ...value, ...(value.bidModifier !== undefined ? { bidModifier: float(value.bidModifier) } : {}) });
const key = (value: Criterion) => `${value.type}:${value.negative}:${value.location?.geoTargetConstant ?? value.language?.languageConstant ?? value.device?.type ?? (value.adSchedule ? digest(value.adSchedule) : value.criterionId)}`;
const scheduleWire = (value: Schedule) => ({ dayOfWeek: value.day, startHour: value.start_hour, startMinute: minuteWire[value.start_minute / 15]!, endHour: value.end_hour, endMinute: minuteWire[value.end_minute / 15]! });
const scheduleText = (value: NonNullable<Criterion['adSchedule']>) => `${value.dayOfWeek} ${String(value.startHour).padStart(2, '0')}:${String(minuteWire.indexOf(value.startMinute) * 15).padStart(2, '0')}–${String(value.endHour).padStart(2, '0')}:${String(minuteWire.indexOf(value.endMinute) * 15).padStart(2, '0')}`;
const multiplierText = (value: number | undefined) => value === undefined ? 'Not reported' : `${Number(value.toPrecision(7))}×`;
const notes = ['Changes can affect delivery immediately on an enabled campaign. Campaign/ad statuses and monetary budgets are preserved; new targeting criteria are enabled within that existing campaign.', 'Bid modifiers are multipliers, not currency micros or monetary ceilings. Native eligibility and bidding strategy determine whether they affect bids.', 'Snapshots cover the returned six criterion types and selected parent/budget/timezone configuration, not performance or every other targeting dimension. Google has no atomic compare-and-set.'];

/** Native v25 protos googleapis@eecf37ae; current targeting guide checked2026-11-06. */
export class GoogleTargetingService {
  constructor(private readonly client: GoogleAdsRestClient) {}
  private async context(accountId: string, campaignId: string) {
    const account = normalizeCustomerId(accountId), campaignResource = `customers/${account}/campaigns/${campaignId}`;
    const customerRows = await this.client.search(account, 'SELECT customer.resource_name, customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 2', { maxRows: 2 });
    const customer = object(customerRows[0]?.customer);
    if (customerRows.length !== 1 || customer.id !== account || customer.resourceName !== `customers/${account}` || typeof customer.timeZone !== 'string' || typeof customer.currencyCode !== 'string') throw new AdportError('PROVIDER_ERROR', 'google: exact customer currency/timezone context was not returned');
    const rows = await this.client.search(account, `SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign.bidding_strategy_type, campaign.campaign_budget, campaign.geo_target_type_setting.positive_geo_target_type, campaign.geo_target_type_setting.negative_geo_target_type, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.total_amount_micros, campaign_budget.period, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${campaignId} LIMIT 2`, { maxRows: 2, includeDrafts: true });
    const campaign = object(rows[0]?.campaign), budget = object(rows[0]?.campaignBudget);
    if (rows.length !== 1 || campaign.id !== campaignId || campaign.resourceName !== campaignResource || !['ENABLED', 'PAUSED'].includes(String(campaign.status)) || typeof campaign.advertisingChannelType !== 'string' || campaign.campaignBudget !== budget.resourceName || !new RegExp(`^customers/${account}/campaignBudgets/[1-9]\\d*$`).test(String(budget.resourceName))) throw new AdportError('INVALID_INPUT', 'google: available campaign and owned budget configuration are required');
    const native = await this.client.search(account, `SELECT campaign.id, ${fields.join(', ')} FROM campaign_criterion WHERE campaign.id = ${campaignId} AND campaign_criterion.status != 'REMOVED' AND campaign_criterion.type IN (${types.map(type => `'${type}'`).join(',')}) ORDER BY campaign_criterion.criterion_id ASC LIMIT ${BOUND + 1}`, { maxRows: BOUND + 1, includeDrafts: true });
    if (native.length > BOUND) throw new AdportError('PROVIDER_ERROR', 'google: complete targeting context exceeds the20,000 criterion safety bound');
    const seen = new Set<string>(), selections = new Set<string>(), criteria = native.map(value => {
      const parsed = nativeTargetingCriterion.safeParse(value.campaignCriterion);
      if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'google: targeting criterion configuration is incomplete or unsupported');
      const row = parsed.data, info = infoFields[row.type];
      if (object(value.campaign).id !== campaignId || row.campaign !== campaignResource || row.resourceName !== `customers/${account}/campaignCriteria/${campaignId}~${row.criterionId}` || seen.has(row.criterionId) || info && !row[info as keyof Criterion] || ['location', 'language', 'device', 'adSchedule'].filter(field => row[field as keyof Criterion] !== undefined).length !== (info ? 1 : 0) || row.negative && ['LANGUAGE', 'DEVICE', 'AD_SCHEDULE', 'PROXIMITY', 'LOCATION_GROUP'].includes(row.type)) throw new AdportError('PROVIDER_ERROR', 'google: criterion identity, hierarchy, type or polarity mismatch');
      if (selections.has(key(row))) throw new AdportError('PROVIDER_ERROR', 'google: duplicate semantic targeting criteria prevent a reliable update');
      seen.add(row.criterionId);selections.add(key(row));return row;
    }).sort((a, b) => BigInt(a.criterionId) < BigInt(b.criterionId) ? -1 : 1);
    const snapshot = { account_id: account, customer, campaign, budget, criteria };
    return { ...snapshot, snapshot_hash: digest(snapshot) };
  }
  private async constants(account: string, ids: string[], kind: 'LOCATION' | 'LANGUAGE', required: boolean) {
    const values = [...new Set(ids)], found = new Map<string, Row>(), resource = kind === 'LOCATION' ? 'geo_target_constant' : 'language_constant', property = kind === 'LOCATION' ? 'geoTargetConstant' : 'languageConstant';
    for (let index = 0; index < values.length; index += 100) {
      const batch = values.slice(index, index + 100), selected = kind === 'LOCATION' ? 'geo_target_constant.resource_name, geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code, geo_target_constant.target_type, geo_target_constant.status' : 'language_constant.resource_name, language_constant.id, language_constant.name, language_constant.code, language_constant.targetable';
      const rows = await this.client.search(account, `SELECT ${selected} FROM ${resource} WHERE ${resource}.id IN (${batch.join(',')}) LIMIT ${batch.length + 1}`, { maxRows: batch.length + 1 });
      for (const raw of rows) {
        const value = object(raw[property]), id = String(value.id ?? '');
        if (!batch.includes(id) || value.resourceName !== `${kind === 'LOCATION' ? 'geoTargetConstants' : 'languageConstants'}/${id}` || found.has(id) || required && (kind === 'LOCATION' ? value.status !== 'ENABLED' : value.targetable !== true)) throw new AdportError('INVALID_INPUT', 'google: referenced targeting constant is unverified, duplicated or not currently targetable');
        found.set(id, value);
      }
    }
    if (required && values.some(id => !found.has(id))) throw new AdportError('INVALID_INPUT', 'google: not every requested targeting constant was returned');
    return found;
  }
  async list(raw: z.input<typeof targetingList>) {
    const input = targetingList.parse(raw), context = await this.context(input.account_id, input.campaign_id);let offset = 0;
    if (input.cursor) {
      try {
        const parsed = z.object({ account: z.string(), campaign: z.string(), hash: z.string(), offset: z.number().int().positive(), size: z.number().int().positive() }).strict().parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
        if (parsed.account !== context.account_id || parsed.campaign !== input.campaign_id || parsed.hash !== context.snapshot_hash || parsed.size !== input.page_size || parsed.offset >= context.criteria.length || parsed.offset % parsed.size) throw new Error('stale cursor');offset = parsed.offset;
      } catch { throw new AdportError('INVALID_INPUT', 'google: targeting continuation changed or belongs to another selection; refresh the first page'); }
    }
    const page = context.criteria.slice(offset, offset + input.page_size), warnings: string[] = [], labels = new Map<string, string>();
    for (const kind of ['LOCATION', 'LANGUAGE'] as const) {
      const ids = page.filter(row => row.type === kind).map(row => (kind === 'LOCATION' ? row.location!.geoTargetConstant : row.language!.languageConstant).split('/').at(-1)!);
      try { for (const [id, value] of await this.constants(context.account_id, ids, kind, false)) if (typeof value.name === 'string') labels.set(`${kind}:${id}`, value.name); }
      catch { warnings.push(`${kind} names were not resolved; native IDs and configuration remain available.`); }
    }
    const languageNote = context.campaign.advertisingChannelType === 'SEARCH' ? 'Search manual language targets are legacy and do not control serving. Only their removal is supported.' : context.campaign.advertisingChannelType === 'PERFORMANCE_MAX' ? 'Performance Max language criteria apply outside Google Search; Search matching is automatic.' : 'Language criterion eligibility remains native campaign-specific.';
    const records = page.map(row => {
      const id = (row.location?.geoTargetConstant ?? row.language?.languageConstant)?.split('/').at(-1), name = id ? labels.get(`${row.type}:${id}`) ?? id : row.device?.type ?? (row.adSchedule ? scheduleText(row.adSchedule) : `Retained ${row.type}`);
      return { id: row.criterionId, name, kind: row.type, scope: row.negative ? 'Excluded' : 'Targeted', status: row.status, ...(row.type === 'DEVICE' || row.type === 'AD_SCHEDULE' ? { bid_multiplier: multiplierText(row.bidModifier) } : {}), ...(row.type === 'LANGUAGE' && context.campaign.advertisingChannelType === 'SEARCH' ? { serving: 'Legacy · not used by Search' } : {}) };
    });
    const end = offset + page.length;
    return { account_id: context.account_id, campaign_id: input.campaign_id, campaign: context.campaign, customer: context.customer, budget: context.budget, snapshot_hash: context.snapshot_hash, records, criteria: page, total_criteria: context.criteria.length, truncated: end < context.criteria.length, ...(end < context.criteria.length ? { next_cursor: Buffer.from(JSON.stringify({ account: context.account_id, campaign: input.campaign_id, hash: context.snapshot_hash, offset: end, size: input.page_size })).toString('base64url') } : {}), notes: [languageNote, 'LOCATION_GROUP and PROXIMITY references are retained and are not edited by this tool. A location-ID list is not the entire geographic targeting model.', ...notes], warnings };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    if (op.provider !== 'google' || op.kind !== 'update' || op.tool !== 'google_update_targeting') throw new AdportError('INVALID_INPUT', 'google: targeting operation provider/kind mismatch');
    const input = targetingUpdate.parse(op.payload), before = await this.context(op.accountId, input.campaign_id);
    if (before.snapshot_hash !== input.expected_snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'google: targeting, parent or budget configuration changed; read and preview it again');
    const campaign = String(before.campaign.resourceName), removals = new Set<string>(), updates = new Map<string, Row>(), creates: Row[] = [], reviewFields: ReviewField[] = [{ label: 'Campaign', after: before.campaign.name }, { label: 'Campaign status', after: before.campaign.status }, { label: 'Account timezone', after: before.customer.timeZone }];
    const patch = (row: Criterion, fields: Row) => updates.set(row.resourceName, { ...updates.get(row.resourceName), ...fields });
    const changeIds = async (kind: 'LOCATION' | 'LANGUAGE', negative: boolean, delta: { add_ids: string[]; remove_ids: string[] } | undefined) => {
      if (!delta) return;
      if (kind === 'LANGUAGE' && before.campaign.advertisingChannelType === 'SEARCH' && delta.add_ids.length) throw new AdportError('INVALID_INPUT', 'google: Search manual language creation/update is no longer supported; only legacy criterion removal is available');
      const current = before.criteria.filter(row => row.type === kind && row.negative === negative), idOf = (row: Criterion) => (kind === 'LOCATION' ? row.location!.geoTargetConstant : row.language!.languageConstant).split('/').at(-1)!;
      if (delta.add_ids.some(id => current.some(row => idOf(row) === id)) || delta.remove_ids.some(id => !current.some(row => idOf(row) === id))) throw new AdportError('INVALID_INPUT', 'google: targeting additions already exist or removals were not found; no mutation submitted');
      const constants = await this.constants(before.account_id, delta.add_ids, kind, true);
      for (const id of delta.remove_ids) removals.add(current.find(row => idOf(row) === id)!.resourceName);
      for (const id of delta.add_ids) creates.push({ campaign, status: 'ENABLED', negative, ...(kind === 'LOCATION' ? { location: { geoTargetConstant: `geoTargetConstants/${id}` } } : { language: { languageConstant: `languageConstants/${id}` } }) });
      if (delta.add_ids.length) reviewFields.push({ label: `Add ${negative ? 'excluded' : 'targeted'} ${kind.toLowerCase()}`, after: delta.add_ids.map(id => `${constants.get(id)?.name ?? id} [${id}]`) });
      if (delta.remove_ids.length) reviewFields.push({ label: `Remove ${negative ? 'excluded' : 'targeted'} ${kind.toLowerCase()}`, after: delta.remove_ids });
    };
    await changeIds('LOCATION', false, input.locations?.include);await changeIds('LOCATION', true, input.locations?.exclude);await changeIds('LANGUAGE', false, input.languages);
    if (input.locations) {
      const retained = before.criteria.filter(row => row.type === 'LOCATION' && !removals.has(row.resourceName));
      const included = new Set([...retained.filter(row => !row.negative).map(row => row.location!.geoTargetConstant), ...creates.filter(row => !row.negative && row.location).map(row => String(object(row.location).geoTargetConstant))]);
      const excluded = new Set([...retained.filter(row => row.negative).map(row => row.location!.geoTargetConstant), ...creates.filter(row => row.negative && row.location).map(row => String(object(row.location).geoTargetConstant))]);
      if ([...included].some(value => excluded.has(value))) throw new AdportError('INVALID_INPUT', 'google: the same location cannot be both explicitly included and excluded');
      if (!included.size) reviewFields.push({ label: 'Remaining included location IDs', after: 'None. Other radius/group criteria and exclusions are retained; without other positive geography, reach is unrestricted by included locations.' });
    }
    if (input.ad_schedules !== undefined) {
      const current = before.criteria.filter(row => row.type === 'AD_SCHEDULE'), wanted = new Set(input.ad_schedules.map(value => digest(scheduleWire(value))));
      for (const row of current) if (!wanted.has(digest(row.adSchedule))) removals.add(row.resourceName);
      for (const value of input.ad_schedules) {
        const wire = scheduleWire(value), existing = current.find(row => equal(row.adSchedule, wire));
        if (!existing) creates.push({ campaign, status: 'ENABLED', negative: false, adSchedule: wire, ...(value.bid_modifier !== undefined ? { bidModifier: value.bid_modifier } : {}) });
        else if (value.bid_modifier !== undefined && float(existing.bidModifier) !== float(value.bid_modifier)) patch(existing, { bidModifier: value.bid_modifier });
      }
      reviewFields.push({ label: 'Weekly schedule', before: current.map(row => `${scheduleText(row.adSchedule!)} · ${multiplierText(row.bidModifier)}`), after: input.ad_schedules.length ? input.ad_schedules.map(value => `${scheduleText(scheduleWire(value))} · ${value.bid_modifier === undefined ? 'preserve matching interval modifier; native default for new intervals' : multiplierText(value.bid_modifier)}`) : 'No ad-schedule time restriction · all day' });
    }
    for (const value of input.device_bid_modifiers ?? []) {
      const current = before.criteria.filter(row => row.type === 'DEVICE' && row.device?.type === value.device);
      if (current.length !== 1) throw new AdportError('INVALID_INPUT', 'google: device bid changes require an existing exact device criterion; device types are not created or removed here');
      const row = current[0]!;if (float(row.bidModifier) !== float(value.bid_modifier)) { patch(row, { bidModifier: value.bid_modifier });reviewFields.push({ label: `${value.device} bid multiplier`, before: multiplierText(row.bidModifier), after: value.bid_modifier === 0 ? '0× · device excluded' : multiplierText(value.bid_modifier) }); }
    }
    const geo: Row = {}, geoMask: string[] = [], existingGeo = object(before.campaign.geoTargetTypeSetting);
    if (before.campaign.advertisingChannelType === 'SEARCH' && (input.positive_geo_target_type === 'SEARCH_INTEREST' || input.negative_geo_target_type === 'PRESENCE_OR_INTEREST')) throw new AdportError('INVALID_INPUT', 'google: Search supports PRESENCE/PRESENCE_OR_INTEREST positive intent and PRESENCE exclusion intent; native validation rejected the selected combination');
    for (const [inputKey, nativeKey] of [['positive_geo_target_type', 'positiveGeoTargetType'], ['negative_geo_target_type', 'negativeGeoTargetType']] as const) if (input[inputKey] !== undefined && input[inputKey] !== existingGeo[nativeKey]) { geo[nativeKey] = input[inputKey];geoMask.push(`geo_target_type_setting.${inputKey}`);reviewFields.push({ label: inputKey === 'positive_geo_target_type' ? 'Location inclusion intent' : 'Location exclusion intent', before: existingGeo[nativeKey] ?? 'Not reported', after: input[inputKey] }); }
    const operations: Row[] = [...removals].map(resource => ({ campaignCriterionOperation: { remove: resource } }));
    for (const [resourceName, changes] of updates) {
      const current = before.criteria.find(row => row.resourceName === resourceName)!;
      if (removals.has(resourceName)) throw new AdportError('INVALID_INPUT', 'google: cannot edit and remove the same criterion');
      const info = Object.fromEntries(['location', 'language', 'device', 'adSchedule'].filter(key => current[key as keyof Criterion] !== undefined).map(key => [key, current[key as keyof Criterion]]));
      operations.push({ campaignCriterionOperation: { update: { resourceName, ...info, ...changes }, updateMask: Object.keys(changes).map(key => key === 'bidModifier' ? 'bid_modifier' : key).join(',') } });
    }
    operations.push(...creates.map(create => ({ campaignCriterionOperation: { create } })));
    if (geoMask.length) operations.push({ campaignOperation: { update: { resourceName: campaign, geoTargetTypeSetting: geo }, updateMask: geoMask.join(',') } });
    if (!operations.length) throw new AdportError('INVALID_INPUT', 'google: no targeting configuration change remains after comparing current values');
    if (operations.length > 5000) throw new AdportError('INVALID_INPUT', 'google: targeting edits exceed the5,000-operation tool bound; use smaller changes');
    const reviewNotes = [...notes, before.campaign.advertisingChannelType === 'SEARCH' ? 'Search legacy language criteria are not used in serving; removal is cleanup, not a new language restriction.' : before.campaign.advertisingChannelType === 'PERFORMANCE_MAX' ? 'Performance Max language settings apply only outside Google Search.' : 'Google validates criterion/campaign compatibility before approval.', 'Schedules use the account timezone, with exclusive end times. [] removes time restrictions. Location/language add/remove lists preserve every unmentioned criterion.'];
    let details: unknown;
    return { summary: `Update Google campaign targeting · ${before.campaign.name}`, changes: reviewFields.map(field => `${field.label}: ${JSON.stringify(field.after)}`), coercions: [], budgetDeltas: [], notes: reviewNotes, review: { provider: 'google', accountId: before.account_id, kind: 'update', title: 'Update campaign targeting', fields: reviewFields, notices: reviewNotes }, resultDetails: () => details,
      execute: async validateOnly => {
        const known = new Set<string>([...removals, ...updates.keys(), ...(geoMask.length ? [campaign] : [])]);
        try {
          const result = await this.client.googleAdsMutate(before.account_id, operations, { validateOnly });
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new AdportError('PROVIDER_ERROR', 'google: targeting mutate response envelope could not be verified');
          const responses = result.mutateOperationResponses;
          if (Array.isArray(responses)) for (const response of responses) for (const value of Object.values(object(response))) if (typeof object(value).resourceName === 'string') known.add(String(object(value).resourceName));
          if ('partialFailureError' in result) throw new Error('unexpected partial failure');
          if (validateOnly) return [];
          if (!Array.isArray(responses) || responses.length !== operations.length) throw new Error('mutation receipt count mismatch');
          const created: Array<{ id: string; value: Row }> = [];
          for (let index = 0; index < operations.length; index++) {
            const operation = operations[index]!, criterionOp = object(operation.campaignCriterionOperation), campaignOp = object(operation.campaignOperation), expectedKey = operation.campaignCriterionOperation ? 'campaignCriterionResult' : 'campaignResult', response = responses[index]!;
            if (Object.keys(response).length !== 1 || !response[expectedKey]) throw new Error('mutation receipt type mismatch');
            const resource = response[expectedKey]!.resourceName;
            if (criterionOp.create) {
              if (typeof resource !== 'string' || !new RegExp(`^customers/${before.account_id}/campaignCriteria/${input.campaign_id}~[1-9]\\d*$`).test(resource) || before.criteria.some(row => row.resourceName === resource) || created.some(row => row.id === resource)) throw new Error('created criterion identity mismatch');
              created.push({ id: resource, value: object(criterionOp.create) });
            } else if (resource !== (criterionOp.remove ?? object(criterionOp.update).resourceName ?? campaignOp.remove ?? object(campaignOp.update).resourceName)) throw new Error('mutation receipt scope mismatch');
          }
          const after = await this.context(before.account_id, input.campaign_id), expectedCampaign = { ...before.campaign, ...(geoMask.length ? { geoTargetTypeSetting: { ...existingGeo, ...geo } } : {}) };
          if (!equal(after.customer, before.customer) || !equal(after.budget, before.budget) || !equal(after.campaign, expectedCampaign)) throw new Error('parent preservation mismatch');
          const expectedIds = new Set(created.map(row => row.id));
          for (const previous of before.criteria) {
            const observed = after.criteria.find(row => row.resourceName === previous.resourceName);
            if (removals.has(previous.resourceName)) { if (observed) throw new Error('removed criterion remains');continue; }
            expectedIds.add(previous.resourceName);
            const expected = { ...previous, ...updates.get(previous.resourceName) } as Criterion;
            if (!observed || !equal(comparable(observed), comparable(expected))) throw new Error('criterion preservation mismatch');
          }
          for (const item of created) {
            const observed = after.criteria.find(row => row.resourceName === item.id);
            if (!observed || Object.entries(item.value).some(([field, expected]) => field === 'bidModifier' ? float(observed.bidModifier) !== float(expected) : !equal(observed[field as keyof Criterion], expected))) throw new Error('created criterion readback mismatch');
          }
          if (after.criteria.some(row => !expectedIds.has(row.resourceName))) throw new Error('unexpected criterion appeared');
          details = { snapshot_hash: after.snapshot_hash, created_criteria: created.map(row => row.id), removed_criteria: [...removals], updated_criteria: [...updates.keys()], independent_scoped_readback_verified: true, other_criterion_types_submitted: false };
          return [...known];
        } catch (error) {
          if (validateOnly) throw error;
          throw new AdportError('PROVIDER_ERROR', 'google: targeting mutation outcome was not confirmed. Reconcile acknowledged IDs and current targeting before another change; no write was retried.', { resourceIds: [...known] });
        }
      } };
  }
}

export function googleTargetingTools(provider: GoogleAdsProvider): AnyToolDefinition[] {
  const catalog = { category: 'audiences' as const, exposure: 'specialist' as const };
  return [
    defineTool({ name: 'google_campaign_targeting', namespace: 'google', catalog, description: 'Read scoped campaign location/language/device/schedule configuration and snapshot_hash. Native statuses, omitted bid multipliers and retained radius/group references remain explicit. Stable snapshot paging supports Load more. Search language criteria are legacy, not serving restrictions.', input: targetingList, presentation: 'records', pagination: { cursorInput: 'cursor' }, annotations: { readOnly: true }, handler: input => provider.targeting.list(input) }),
    guardedWriteTool({ name: 'google_update_targeting', namespace: 'google', provider: 'google', catalog, kind: 'update', description: 'Edit existing campaign targeting with snapshot_hash and delivery-effects acknowledgement. Location/language additions/removals preserve unmentioned criteria; schedules replace weekly intervals; device multipliers edit existing types. Exact native masks, atomic validateOnly and independent readback. Search languages can only be removed.', payload: targetingUpdate }),
  ];
}
