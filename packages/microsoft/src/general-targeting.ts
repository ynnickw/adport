import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type ReviewField, type WriteGuard, type WriteOperation } from '@adport/core';
import { MicrosoftNativeService, microsoftNativeId as nativeId, microsoftRow as row, microsoftRows as rows, type MicrosoftPlan, type MicrosoftRow as Row } from './native.js';
import { criterionType, minutes, nativeTarget } from './targeting-schemas.js';
import { targetSelection, targetingRead, targetingWrite } from './general-targeting-schemas.js';
import type { MicrosoftAdsProvider } from './provider.js';

type Target = z.infer<typeof targetSelection>;
type Kind = z.infer<typeof criterionType>;
const BOUND = 20_000;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const pick = (value: Row, fields: string[]) => Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
const optionalRow = (value: unknown): Row => value === undefined || value === null ? {} : row(value);
const kind = (value: Row) => criterionType.parse(String(row(value.Criterion).Type).replace(/Criterion$/, ''));
const entityId = (target: Target) => target.type === 'Campaign' ? target.campaign_id : target.ad_group_id;
const geo = (value: Row) => ['Location', 'Radius'].includes(kind(value));
function title(value: Row): string {
  const data = row(value.Criterion), type = kind(value), text = (field: string) => data[field] === undefined || data[field] === null ? 'Not reported' : String(data[field]);
  if (type === 'Device') return text('DeviceName');
  if (type === 'Location') return `Location ${text('LocationId')}`;
  if (type === 'Radius') return `${data.Name || 'Radius'} · ${text('Radius')} ${text('RadiusUnit')} · ${text('LatitudeDegrees')}, ${text('LongitudeDegrees')}`;
  if (type === 'Age') return text('AgeRange').replace(/([a-z])([A-Z])/g, '$1 $2');
  if (type === 'Gender') return text('GenderType');
  if (type === 'LocationIntent') return text('IntentOption').replace(/([a-z])([A-Z])/g, '$1 $2');
  const time = (end: boolean) => { const hour = data[end ? 'ToHour' : 'FromHour'], minute = data[end ? 'ToMinute' : 'FromMinute'];return typeof hour === 'number' && typeof minute === 'string' && Object.hasOwn(minutes, minute) ? `${String(hour).padStart(2, '0')}:${String(minutes[minute as keyof typeof minutes]).padStart(2, '0')}` : 'Not reported'; };
  return `${text('Day')} ${time(false)}–${time(true)}`;
}
const identity = (value: Row) => {
  const fields: Record<Kind, string[]> = { Age: ['AgeRange'], Gender: ['GenderType'], Device: ['DeviceName'], DayTime: ['Day', 'FromHour', 'FromMinute', 'ToHour', 'ToMinute'], Location: ['LocationId'], LocationIntent: [], Radius: ['LatitudeDegrees', 'LongitudeDegrees', 'Radius', 'RadiusUnit'] };
  const criterion = row(value.Criterion);return digest({ type: kind(value), fields: fields[kind(value)].map(field => String(criterion[field] ?? '')) });
};
const notices = ['Ad-group criteria override campaign criteria of the same type. Locations, negative locations and radii form one geo family: any ad-group geo criterion disables inheritance of ALL campaign geo criteria. Location intent alone does not change the geo source.', 'Device and schedule criteria override rather than combine with campaign settings. Removing the last ad-group criterion can restore inherited targeting; adding the first can broaden or narrow delivery.', 'BidMultiplier carries whole percentage points, not a ratio or currency micros. Automated bidding can treat it as a signal. Location intent has no bid. Criteria have native Active status without an independent pause.', 'A configuration hash detects observed changes before submission, not concurrent changes during a native request. Reads and preservation checks cover these seven criterion families and selected parent/account configuration, not every native targeting feature.'];
export const MICROSOFT_GENERAL_TARGETING_WRITES = new Set(['microsoft_update_targeting']);

/** MicrosoftDocs@5bde65c3, BingAds REST SDK@4b6fb31c; one native mutation per approval. */
export class MicrosoftGeneralTargetingService extends MicrosoftNativeService {
  private async query(account: string, target: Target, type: Kind) {
    const prefix = target.type, result = await this.request(account, `${prefix}Criterions/QueryByIds`, { [`${prefix}Id`]: entityId(target), [`${prefix}CriterionIds`]: null, CriterionType: type });
    if (!Object.hasOwn(result, `${prefix}Criterions`)) throw new AdportError('PROVIDER_ERROR', 'microsoft: complete target criteria were not returned');
    const values = rows(result[`${prefix}Criterions`]);
    if (values.length > BOUND || new Set(values.map(value => nativeId(value.Id))).size !== values.length || values.some(value => nativeId(value[`${prefix}Id`]) !== entityId(target) || kind(value) !== type || ![`Biddable${prefix}Criterion`, `Negative${prefix}Criterion`].includes(String(value.Type)))) throw new AdportError('PROVIDER_ERROR', 'microsoft: targeting response identity, scope or safety bound mismatch');
    return values.filter(value => value.Status !== 'Deleted');
  }
  private async all(account: string, target: Target) {
    const values: Row[] = [];
    for (let i = 0; i < criterionType.options.length; i += 3) values.push(...(await Promise.all(criterionType.options.slice(i, i + 3).map(type => this.query(account, target, type)))).flat());
    if (values.length > BOUND || new Set(values.map(value => nativeId(value.Id))).size !== values.length) throw new AdportError('PROVIDER_ERROR', 'microsoft: targeting snapshot exceeds its bound or contains duplicate IDs');
    return values.sort((a, b) => BigInt(nativeId(a.Id)) < BigInt(nativeId(b.Id)) ? -1 : 1);
  }
  private async context(account: string, target: Target) {
    const scope = await this.accountScope(account, true), known = await this.campaign(account, target.campaign_id);
    const accountResult = await this.request(account, 'Account/Query', { AccountId: account }, 'POST', 'customer'), nativeAccount = row(accountResult.Account);
    if (nativeId(nativeAccount.Id) !== account || nativeId(nativeAccount.ParentCustomerId) !== scope.customerId) throw new AdportError('PROVIDER_ERROR', 'microsoft: account/timezone ownership could not be verified');
    const accountContext = pick(nativeAccount, ['Id', 'ParentCustomerId', 'CurrencyCode', 'TimeZone', 'AccountLifeCycleStatus']);
    const parents = rows((await this.request(account, 'Campaigns/QueryByIds', { AccountId: account, CampaignIds: [target.campaign_id], CampaignType: known.CampaignType, ReturnAdditionalFields: 'TargetSetting, AdScheduleUseSearcherTimeZone' })).Campaigns);
    if (parents.length !== 1 || nativeId(parents[0]!.Id) !== target.campaign_id || parents[0]!.CampaignType !== known.CampaignType || !['Active', 'Paused'].includes(String(parents[0]!.Status))) throw new AdportError('INVALID_INPUT', 'microsoft: campaign context is unavailable or mismatched');
    const campaign = pick(parents[0]!, ['Id', 'Name', 'Status', 'CampaignType', 'SubType', 'DailyBudget', 'BudgetType', 'BudgetId', 'BiddingScheme', 'ExperimentId', 'Settings', 'AdScheduleUseSearcherTimeZone']);
    let group: Row | undefined;
    if (target.type === 'AdGroup') {
      if (campaign.CampaignType === 'PerformanceMax') throw new AdportError('INVALID_INPUT', 'microsoft: Performance Max has asset groups, not ordinary ad-group targeting');
      const groups = rows((await this.request(account, 'AdGroups/QueryByIds', { CampaignId: target.campaign_id, AdGroupIds: [target.ad_group_id], ReturnAdditionalFields: 'AdGroupType, AdScheduleUseSearcherTimeZone' })).AdGroups);
      if (groups.length !== 1 || nativeId(groups[0]!.Id) !== target.ad_group_id || !['Active', 'Paused'].includes(String(groups[0]!.Status))) throw new AdportError('INVALID_INPUT', 'microsoft: ad group was not found in the selected campaign/account');
      group = pick(groups[0]!, ['Id', 'Name', 'Status', 'AdGroupType', 'Language', 'CpcBid', 'CpmBid', 'CpvBid', 'BiddingScheme', 'StartDate', 'EndDate', 'Settings', 'AdScheduleUseSearcherTimeZone']);
    }
    const campaignCriteria = await this.all(account, { type: 'Campaign', campaign_id: target.campaign_id }), ownCriteria = target.type === 'AdGroup' ? await this.all(account, target) : campaignCriteria;
    const data = { account_id: account, target, account: accountContext, campaign, group, campaignCriteria, ownCriteria };
    return { ...data, context_hash: digest(data) };
  }
  private inherited(context: Awaited<ReturnType<MicrosoftGeneralTargetingService['context']>>, own = context.ownCriteria) {
    return Object.fromEntries(criterionType.options.map(type => {
      const useOwn = context.target.type === 'Campaign' || (['Location', 'Radius', 'LocationIntent'].includes(type) ? own.some(geo) : own.some(value => kind(value) === type));
      const source = useOwn ? context.target.type : 'Campaign', selected = useOwn ? own : context.campaignCriteria;
      return [type, { source, criterion_count: selected.filter(value => kind(value) === type).length }];
    }));
  }
  private clock(context: Awaited<ReturnType<MicrosoftGeneralTargetingService['context']>>, own = context.ownCriteria) {
    const source = this.inherited(context, own).DayTime!.source, parent = source === 'AdGroup' ? context.group! : context.campaign, flag = parent.AdScheduleUseSearcherTimeZone;
    return { source, use_searcher_time_zone: typeof flag === 'boolean' ? flag : null, timezone: flag === true ? 'Searcher local time' : flag === false ? context.account.TimeZone ?? 'Account time zone not reported' : 'Schedule clock not reported' };
  }
  private geography(context: Awaited<ReturnType<MicrosoftGeneralTargetingService['context']>>, own = context.ownCriteria) {
    const source = this.inherited(context, own).Location!.source, selected = source === context.target.type ? own : context.campaignCriteria, included = selected.filter(value => kind(value) === 'Location' && String(value.Type).startsWith('Biddable')), excluded = selected.filter(value => kind(value) === 'Location' && String(value.Type).startsWith('Negative')), radii = selected.filter(value => kind(value) === 'Radius');
    return { source, included_location_count: included.length, excluded_location_count: excluded.length, radius_count: radii.length, included_location_ids: included.slice(0, 20).map(value => row(value.Criterion).LocationId), ids_truncated: included.length > 20, ...(!included.length && !radii.length ? { reach: 'No positive location/radius restriction; exclusions and native campaign eligibility still apply.' } : {}) };
  }
  async list(raw: z.input<typeof targetingRead>) {
    const input = targetingRead.parse(raw), context = await this.context(input.account_id, input.target), types = [...input.criterion_types].sort(), visible = [...context.ownCriteria.map(criterion => ({ source: input.target.type, criterion })), ...(input.target.type === 'AdGroup' ? context.campaignCriteria.map(criterion => ({ source: 'Campaign' as const, criterion })) : [])].filter(value => input.criterion_types.includes(kind(value.criterion)));
    let offset = 0;
    if (input.cursor) try {
      const cursor = z.object({ account: z.string(), target: targetSelection, hash: z.string(), types: z.array(z.string()), size: z.number().int().positive(), offset: z.number().int().positive() }).strict().parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
      if (cursor.account !== input.account_id || !same(cursor.target, input.target) || cursor.hash !== context.context_hash || !same(cursor.types, types) || cursor.size !== input.page_size || cursor.offset >= visible.length || cursor.offset % cursor.size) throw new Error('Selection changed');offset = cursor.offset;
    } catch { throw new AdportError('PENDING_MISMATCH', 'microsoft: targeting continuation is stale or belongs to another selection; refresh the first page'); }
    const inheritance = this.inherited(context), page = visible.slice(offset, offset + input.page_size), end = offset + page.length;
    return { account_id: input.account_id, target: input.target, context_hash: context.context_hash, account: context.account, campaign: context.campaign, ad_group: context.group, inheritance, schedule_clock: this.clock(context), total_criteria: visible.length, criteria: page,
      records: page.map(({ source, criterion }) => { const type = kind(criterion), bid = optionalRow(criterion.CriterionBid).Multiplier, selected = inheritance[type]!.source === source, hasGeo = inheritance.Location!.criterion_count + inheritance.Radius!.criterion_count > 0;return { id: `${source}:${nativeId(criterion.Id)}`, criterion_id: nativeId(criterion.Id), kind: type, name: title(criterion), source, effective: selected && (type !== 'LocationIntent' || hasGeo), status: criterion.Status ?? 'Not reported', bid_adjustment: typeof bid === 'number' ? `${bid}%${type === 'Device' && bid === -100 ? ' · device excluded' : ''}` : type === 'LocationIntent' || String(criterion.Type).startsWith('Negative') ? 'Not applicable' : 'Not reported' }; }),
      truncated: end < visible.length, ...(end < visible.length ? { next_cursor: Buffer.from(JSON.stringify({ account: input.account_id, target: input.target, hash: context.context_hash, types, size: input.page_size, offset: end })).toString('base64url') } : {}), notes: [...notices, 'Both owned and campaign criteria are shown. Effective identifies the selected source, not eligibility or delivery; false marks overridden/inapplicable rows. Intent without geographic criteria is inapplicable. Only owned IDs can be edited at the selected scope.'] };
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<MicrosoftPlan> {
    if (op.tool !== 'microsoft_update_targeting' || op.provider !== 'microsoft' || op.kind !== 'update') throw new AdportError('INVALID_INPUT', 'microsoft: scoped targeting operation provider/kind mismatch');
    const input = targetingWrite.parse(op.payload), before = await this.context(op.accountId, input.target), change = input.change, prefix = input.target.type, parentKey = `${prefix}Id`, selectedParent = before.group ?? before.campaign;
    if (before.context_hash !== input.expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'microsoft: targeting, inheritance or parent/account configuration changed; read and preview again');
    let method: 'POST' | 'PUT' | 'DELETE' = 'PUT', path = `${prefix}Criterions`, body: Row = {}, creates: Row[] = [], removed: string[] = [], updated: Row | undefined, clock: boolean | undefined;
    const selected = (id: string) => { const found = before.ownCriteria.find(value => nativeId(value.Id) === id);if (!found) throw new AdportError('INVALID_INPUT', 'microsoft: criterion is not owned by the selected entity; inherited criterion IDs cannot be edited here');return found; };
    if (change.action === 'add') {
      if (guard.forcePausedCreation && before.campaign.Status !== 'Paused' && before.group?.Status !== 'Paused') throw new AdportError('POLICY_VIOLATION', 'microsoft: new targets are natively Active; paused_creation requires an effectively paused parent');
      creates = change.targets.map(value => nativeTarget({ [parentKey]: entityId(input.target) }, value));
      const seen = new Set(before.ownCriteria.map(identity));
      for (const value of creates) { if (seen.has(identity(value))) throw new AdportError('INVALID_INPUT', 'microsoft: target already exists or is duplicated in this request; use an explicit edit');seen.add(identity(value)); }
      method = 'POST';body = { [`${prefix}Criterions`]: creates, CriterionType: 'Targets' };
    } else if (change.action === 'remove') {
      removed = change.criterion_ids;const values = removed.map(selected);
      if (values.some(value => kind(value) === 'LocationIntent')) throw new AdportError('INVALID_INPUT', 'microsoft: location intent cannot be deleted; restore its default with set_location_intent');
      if (values.some(value => kind(value) === 'Device') && before.ownCriteria.some(value => kind(value) === 'Device' && !removed.includes(nativeId(value.Id)))) throw new AdportError('INVALID_INPUT', 'microsoft: remove the complete device set together');
      method = 'DELETE';body = { [parentKey]: entityId(input.target), [`${prefix}CriterionIds`]: removed, CriterionType: 'Targets' };
    } else if (change.action === 'set_schedule_clock') {
      if (selectedParent.AdScheduleUseSearcherTimeZone === change.use_searcher_time_zone) throw new AdportError('INVALID_INPUT', 'microsoft: schedule clock already has this value');clock = change.use_searcher_time_zone;
      path = prefix === 'Campaign' ? 'Campaigns' : 'AdGroups';body = { [prefix === 'Campaign' ? 'AccountId' : 'CampaignId']: prefix === 'Campaign' ? op.accountId : input.target.campaign_id, [path]: [{ Id: entityId(input.target), AdScheduleUseSearcherTimeZone: clock }] };
    } else {
      const current = selected(change.criterion_id), type = kind(current);
      if (current.Type !== `Biddable${prefix}Criterion`) throw new AdportError('INVALID_INPUT', 'microsoft: excluded targets cannot have a bid or intent edit');
      updated = { ...current };
      if (change.action === 'set_bid') {
        const bid = optionalRow(current.CriterionBid);
        if (type !== change.criterion_type || bid.Type !== 'BidMultiplier' || typeof bid.Multiplier !== 'number' || !Number.isFinite(bid.Multiplier)) throw new AdportError('INVALID_INPUT', 'microsoft: owned biddable criterion with a verified native percentage is required');
        if (bid.Multiplier === change.bid_adjustment_percent) throw new AdportError('INVALID_INPUT', 'microsoft: bid adjustment is unchanged');updated.CriterionBid = { Type: 'BidMultiplier', Multiplier: change.bid_adjustment_percent };
        body = { [`${prefix}Criterions`]: [{ [parentKey]: entityId(input.target), Id: change.criterion_id, Type: current.Type, CriterionBid: updated.CriterionBid }], CriterionType: 'Targets' };
      } else {
        if (type !== 'LocationIntent') throw new AdportError('INVALID_INPUT', 'microsoft: location intent requires its exact criterion ID');if (row(current.Criterion).IntentOption === change.intent_option) throw new AdportError('INVALID_INPUT', 'microsoft: location intent is unchanged');updated.Criterion = { ...row(current.Criterion), IntentOption: change.intent_option };
        body = { [`${prefix}Criterions`]: [{ [parentKey]: entityId(input.target), Id: change.criterion_id, Type: current.Type, Criterion: updated.Criterion }], CriterionType: 'Targets' };
      }
    }
    const afterOwn = [...before.ownCriteria.filter(value => !removed.includes(nativeId(value.Id))).map(value => updated && nativeId(updated.Id) === nativeId(value.Id) ? updated : value), ...creates];
    const touched = new Set<Kind>([...creates.map(kind), ...before.ownCriteria.filter(value => removed.includes(nativeId(value.Id))).map(kind), ...(updated ? [kind(updated)] : [])]);
    this.validateResultingCriteria(afterOwn, touched);
    const touchesSchedule = clock !== undefined || creates.some(value => kind(value) === 'DayTime') || before.ownCriteria.some(value => removed.includes(nativeId(value.Id)) && kind(value) === 'DayTime');
    if (touchesSchedule && (clock ?? selectedParent.AdScheduleUseSearcherTimeZone) !== true && (typeof (clock ?? selectedParent.AdScheduleUseSearcherTimeZone) !== 'boolean' || typeof before.account.TimeZone !== 'string' || !before.account.TimeZone)) throw new AdportError('INVALID_INPUT', 'microsoft: schedule clock/account time zone is not verified; set an explicit clock and read fresh context');
    const projected = { ...before, campaign: { ...before.campaign, ...(prefix === 'Campaign' && clock !== undefined ? { AdScheduleUseSearcherTimeZone: clock } : {}) }, group: before.group ? { ...before.group, ...(prefix === 'AdGroup' && clock !== undefined ? { AdScheduleUseSearcherTimeZone: clock } : {}) } : undefined };
    const effectiveBefore = this.inherited(before), effectiveAfter = this.inherited(before, afterOwn), fields: ReviewField[] = [{ label: 'Campaign', after: `${before.campaign.Name ?? 'Not reported'} [${input.target.campaign_id}]` }, ...(before.group ? [{ label: 'Ad group', after: `${before.group.Name ?? 'Not reported'} [${entityId(input.target)}]` }] : []), { label: 'Scope', after: input.target }, { label: 'Campaign status', after: before.campaign.Status }, ...(before.group ? [{ label: 'Ad group status', after: before.group.Status }] : []), { label: 'Change', after: change }, { label: 'Effective targeting', before: effectiveBefore, after: effectiveAfter }, { label: 'Geographic reach', before: this.geography(before), after: this.geography(before, afterOwn) }, { label: 'Schedule clock', before: this.clock(before), after: this.clock(projected, afterOwn) }, ...(clock !== undefined ? [{ label: 'Use searcher timezone', before: selectedParent.AdScheduleUseSearcherTimeZone ?? 'Not reported', after: clock }] : [])];
    let details: unknown;const known = new Set<string>([...removed, ...(updated ? [nativeId(updated.Id)] : []), ...(clock !== undefined ? [entityId(input.target)] : [])]);
    return { summary: `Update Microsoft ${prefix} targeting · ${change.action}`, changes: [`${method} ${path}; only approved target fields are submitted.`, `${creates.length} additions, ${removed.length} removals, ${updated ? 1 : 0} criterion updates.`, 'Other returned criteria and parent statuses/budgets/settings are preserved. Immutable schedule intervals require separate reviewed remove/add operations; pause delivery before a multi-step replacement.'], coercions: [], budgetDeltas: [], notes: notices, review: { provider: 'microsoft', accountId: op.accountId, kind: 'update', title: 'Update targeting', fields, notices }, resultDetails: () => details,
      execute: async () => {
        try {
          const result = await this.request(op.accountId, path, body, method), acknowledged = result[`${prefix}CriterionIds`];
          if (Array.isArray(acknowledged)) for (const id of acknowledged) try { known.add(nativeId(id)); } catch { /* Retain the other acknowledged IDs. */ }
          const createdIds = method === 'POST' ? rowsOfIds(acknowledged) : [];
          if (method === 'POST' && (createdIds.length !== creates.length || new Set(createdIds).size !== createdIds.length || createdIds.some(id => before.ownCriteria.some(value => nativeId(value.Id) === id)))) throw new Error('Creation receipt mismatch');
          const after = await this.context(op.accountId, input.target), expectedCampaign = { ...before.campaign, ...(prefix === 'Campaign' && clock !== undefined ? { AdScheduleUseSearcherTimeZone: clock } : {}) }, expectedGroup = before.group ? { ...before.group, ...(prefix === 'AdGroup' && clock !== undefined ? { AdScheduleUseSearcherTimeZone: clock } : {}) } : undefined;
          if (!same(after.account, before.account) || !same(after.campaign, expectedCampaign) || !same(after.group, expectedGroup) || prefix === 'AdGroup' && !same(after.campaignCriteria, before.campaignCriteria)) throw new Error('Parent preservation mismatch');
          const expectedIds = new Set([...before.ownCriteria.filter(value => !removed.includes(nativeId(value.Id))).map(value => nativeId(value.Id)), ...createdIds]);
          if (after.ownCriteria.length !== expectedIds.size || after.ownCriteria.some(value => !expectedIds.has(nativeId(value.Id)))) throw new Error('Criterion inventory mismatch');
          for (const previous of before.ownCriteria) {
            if (removed.includes(nativeId(previous.Id))) continue;
            const observed = after.ownCriteria.find(value => nativeId(value.Id) === nativeId(previous.Id)), expected = updated && nativeId(updated.Id) === nativeId(previous.Id) ? updated : previous;
            if (!same(observed, expected)) throw new Error('Criterion preservation mismatch');
          }
          for (let i = 0; i < creates.length; i++) { const observed = after.ownCriteria.find(value => nativeId(value.Id) === createdIds[i]);if (!observed || !contains(observed, creates[i]!)) throw new Error('Created criterion mismatch'); }
          details = { snapshot_hash: after.context_hash, created_criterion_ids: createdIds, removed_criterion_ids: removed, updated_criterion_ids: updated ? [nativeId(updated.Id)] : [], independent_readback_verified: true, inheritance: this.inherited(after), schedule_clock: this.clock(after) };return [...known];
        } catch (error) {
          if (error instanceof AdportError && error.details && typeof error.details === 'object' && Array.isArray((error.details as Row).resourceIds)) for (const id of (error.details as Row).resourceIds as unknown[]) try { known.add(nativeId(id)); } catch { /* Ignore invalid IDs. */ }
          throw new AdportError('PROVIDER_ERROR', 'microsoft: targeting outcome was not confirmed. Reconcile known IDs and current configuration before another mutation; no write was retried.', { resourceIds: [...known] });
        }
      },
    };
  }
  private validateResultingCriteria(values: Row[], touched: Set<Kind>) {
    const devices = values.filter(value => kind(value) === 'Device');
    if (touched.has('Device') && devices.length && (devices.length !== 3 || !['Computers', 'Smartphones', 'Tablets'].every(name => devices.some(value => row(value.Criterion).DeviceName === name)) || devices.some(value => !String(value.Type).startsWith('Biddable') || optionalRow(value.CriterionBid).Type !== 'BidMultiplier' || typeof optionalRow(value.CriterionBid).Multiplier !== 'number') || devices.every(value => optionalRow(value.CriterionBid).Multiplier === -100))) throw new AdportError('INVALID_INPUT', 'microsoft: targeting requires a complete supported three-device set with at least one device included');
    const schedule = values.filter(value => kind(value) === 'DayTime').map(value => row(value.Criterion));
    if (touched.has('DayTime') && schedule.length > 49) throw new AdportError('INVALID_INPUT', 'microsoft: maximum49weekly schedules');
    const number = (value: Row, end: boolean) => { const hour = value[end ? 'ToHour' : 'FromHour'], minute = value[end ? 'ToMinute' : 'FromMinute'];if (typeof hour !== 'number' || !Number.isInteger(hour) || typeof minute !== 'string' || !Object.hasOwn(minutes, minute)) throw new AdportError('PROVIDER_ERROR', 'microsoft: native schedule interval is incomplete');return hour * 60 + minutes[minute as keyof typeof minutes]; };
    if (touched.has('DayTime')) for (const day of new Set(schedule.map(value => value.Day))) { const entries = schedule.filter(value => value.Day === day).sort((a, b) => number(a, false) - number(b, false));if (entries.length > 7 || entries.some((value, index) => number(value, true) <= number(value, false) || index > 0 && number(value, false) < number(entries[index - 1]!, true))) throw new AdportError('INVALID_INPUT', 'microsoft: schedules must not overlap or exceed seven per day'); }
    if (touched.has('Location') && values.filter(value => kind(value) === 'Location').length > 10_000) throw new AdportError('INVALID_INPUT', 'microsoft: combined included/excluded locations exceed10000');
  }
}
function rowsOfIds(value: unknown): string[] { if (!Array.isArray(value)) return [];return value.map(nativeId); }
function contains(actual: Row, expected: Row): boolean { return Object.entries(expected).every(([key, value]) => value && typeof value === 'object' && !Array.isArray(value) ? actual[key] && typeof actual[key] === 'object' && contains(row(actual[key]), row(value)) : key === 'Type' ? String(actual[key]).replace(/Criterion$/, '') === String(value).replace(/Criterion$/, '') : String(actual[key]) === String(value)); }
export function microsoftGeneralTargetingTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  const catalog = { category: 'audiences' as const, exposure: 'specialist' as const };
  return [
    defineTool({ name: 'microsoft_targeting_context', namespace: 'microsoft', catalog, description: 'Read owned and inherited campaign/ad-group general targets, effective sources, schedule clock and context_hash. Seven concrete types, complete bounded context and stable paging; bid values are percentages. This is not audience targeting or every native targeting family.', input: targetingRead, presentation: 'records', pagination: { cursorInput: 'cursor' }, annotations: { readOnly: true }, handler: input => provider.generalTargeting.list(input) }),
    guardedWriteTool({ name: 'microsoft_update_targeting', namespace: 'microsoft', provider: 'microsoft', catalog, kind: 'update', description: 'Edit scoped targeting with expected_context_hash and delivery-effects acknowledgement. One native add, remove, bid, location-intent or schedule-clock operation per approval. Preserves unmentioned criteria/status/budgets; checks inheritance, full devices and schedule limits. New criteria require an effectively paused parent under paused_creation.', payload: targetingWrite }),
  ];
}
