import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteGuard, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { microsoftAudienceType } from './audiences.js';
import { MicrosoftNativeService, microsoftId as id, microsoftNativeId as nativeId, microsoftRow as row, microsoftRows as rows, type MicrosoftPlan, type MicrosoftRow as Row } from './native.js';
import type { MicrosoftAdsProvider } from './provider.js';

const audienceType = microsoftAudienceType.exclude(['CustomSegment']);
const selectors = { Custom: 'CustomAudience', InMarket: 'InMarketAudience', Product: 'ProductAudience', RemarketingList: 'RemarketingList', SimilarRemarketingList: 'SimilarRemarketingList', CombinedList: 'CombinedList', CustomerList: 'CustomerList', ImpressionBasedRemarketingList: 'ImpressionBasedRemarketingList' } as const;
const target = z.discriminatedUnion('type', [z.object({ type: z.literal('Campaign'), campaign_id: id }), z.object({ type: z.literal('AdGroup'), campaign_id: id, ad_group_id: id })]);
const hash = z.string().regex(/^[a-f0-9]{64}$/), adjustment = z.number().int().min(-90).max(900);
const add = z.object({ target, audience_id: id, audience_type: audienceType, expected_audience_snapshot_hash: hash, exclude: z.boolean().default(false), bid_adjustment_percent: adjustment.optional(), expected_target_and_bid: z.boolean().optional() }).superRefine((value, ctx) => {
  if (value.exclude && (value.bid_adjustment_percent !== undefined || value.expected_target_and_bid !== undefined)) ctx.addIssue({ code: 'custom', message: 'Exclusions have no bid adjustment and are independent of positive target mode' });
  if (!value.exclude && value.expected_target_and_bid === undefined) ctx.addIssue({ code: 'custom', message: 'Positive associations require expected_target_and_bid from microsoft_audience_targets' });
});
const reference = z.object({ target, audience_type: audienceType, criterion_id: id, expected_snapshot_hash: hash });
const bid = reference.extend({ bid_adjustment_percent: adjustment });
const mode = z.object({ target, expected_context_hash: hash, target_and_bid: z.boolean() });
const context = z.object({ account_id: id, target, campaign_status: z.string(), ad_group_status: z.string().optional(), target_and_bid: z.boolean(), audience_target_option: z.enum(['TargetAndBid', 'BidOnly']), context_hash: hash });
type Target = z.infer<typeof target>;
type AudienceType = z.infer<typeof audienceType>;
type Source = { audience: Row; snapshot_hash: string };
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : value; }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const prefix = (value: Target) => value.type;
const entityId = (value: Target) => value.type === 'Campaign' ? value.campaign_id : value.ad_group_id;
const isTargetSetting = (value: Row) => ['Target', 'TargetSetting'].includes(String(value.Type));
const orderedDetails = (value: Row[]) => [...value].sort((a, b) => String(a.CriterionTypeGroup).localeCompare(String(b.CriterionTypeGroup)));
const notices = ['Audience criteria have native Active status, without an independent pause. Default paused_creation requires an effectively paused parent for new associations.', 'Positive audiences can be associated at campaign or ad-group level, but not both within one campaign. Exclusions can exist at both levels and Microsoft applies their union.', 'TargetAndBid restricts positive audience delivery; BidOnly adjusts bids without adding that restriction. Exclusions apply regardless. Automated bidding can treat bid percentages as signals. Snapshots detect changes before submission; Microsoft has no atomic compare-and-set.'];
export const MICROSOFT_AUDIENCE_TARGETING_WRITES = new Set(['microsoft_add_audience_target', 'microsoft_set_audience_target_bid', 'microsoft_remove_audience_target', 'microsoft_set_audience_target_mode']);

/** Audience selector on mutations; concrete native selectors on reads. TargetSetting.Details updates replace the complete list. */
export class MicrosoftAudienceTargetingService extends MicrosoftNativeService {
  constructor(...args: [...ConstructorParameters<typeof MicrosoftNativeService>, (account: string, audience: string, type: AudienceType) => Promise<Source>]) {
    const [client, scope, campaign, source] = args; super(client, scope, campaign); this.source = source;
  }
  private readonly source: (account: string, audience: string, type: AudienceType) => Promise<Source>;

  private async entity(account: string, value: Target, refresh = false) {
    await this.accountScope(account, refresh);
    const known = await this.campaign(account, value.campaign_id);
    const result = await this.request(account, 'Campaigns/QueryByIds', { AccountId: account, CampaignIds: [value.campaign_id], CampaignType: known.CampaignType, ReturnAdditionalFields: 'TargetSetting' }), campaigns = rows(result.Campaigns);
    if (campaigns.length !== 1 || nativeId(campaigns[0]!.Id) !== value.campaign_id || campaigns[0]!.CampaignType !== known.CampaignType || typeof campaigns[0]!.Status !== 'string') throw new AdportError('PROVIDER_ERROR', 'microsoft: audience target campaign context is unavailable or mismatched');
    const campaign = campaigns[0]!;
    let group: Row | undefined;
    if (value.type === 'AdGroup') {
      if (campaign.CampaignType === 'PerformanceMax') throw new AdportError('INVALID_INPUT', 'microsoft: Performance Max audiences use campaign exclusions or asset-group signals, not ordinary ad-group criteria');
      const groups = rows((await this.request(account, 'AdGroups/QueryByIds', { CampaignId: value.campaign_id, AdGroupIds: [value.ad_group_id], ReturnAdditionalFields: 'AdGroupType' })).AdGroups);
      if (groups.length !== 1 || nativeId(groups[0]!.Id) !== value.ad_group_id || typeof groups[0]!.Status !== 'string') throw new AdportError('INVALID_INPUT', 'microsoft: ad group was not found in the selected campaign/account');
      group = groups[0]!;
    }
    const entity = group ?? campaign, settings = rows(entity.Settings), targetSettings = settings.filter(isTargetSetting);
    if (targetSettings.length > 1) throw new AdportError('PROVIDER_ERROR', 'microsoft: duplicate target settings in the selected entity');
    const details = orderedDetails(rows(targetSettings[0]?.Details));
    if (details.some(value => typeof value.CriterionTypeGroup !== 'string' || typeof value.TargetAndBid !== 'boolean') || new Set(details.map(value => value.CriterionTypeGroup)).size !== details.length) throw new AdportError('PROVIDER_ERROR', 'microsoft: target-setting details are incomplete or duplicated');
    const targetAndBid = details.find(value => value.CriterionTypeGroup === 'Audience')?.TargetAndBid === true;
    const visible = { account_id: account, target: value, campaign_status: campaign.Status, ...(group ? { ad_group_status: String(group.Status) } : {}), target_and_bid: targetAndBid, audience_target_option: targetAndBid ? 'TargetAndBid' as const : 'BidOnly' as const };
    return { campaign, group, entity, settings, targetSettings, details, context: { ...visible, context_hash: digest({ ...visible, targetSettings }) } };
  }

  private async query(account: string, value: Target, type: AudienceType) {
    const kind = prefix(value), result = await this.request(account, `${kind}Criterions/QueryByIds`, { [`${kind}Id`]: entityId(value), [`${kind}CriterionIds`]: null, CriterionType: selectors[type] });
    if (!Object.hasOwn(result, `${kind}Criterions`)) throw new AdportError('PROVIDER_ERROR', 'microsoft: audience criterion response envelope is missing');
    const values = rows(result[`${kind}Criterions`]);
    if (new Set(values.map(value => nativeId(value.Id))).size !== values.length || values.some(criterion => nativeId(criterion[`${kind}Id`]) !== entityId(value) || ![`Biddable${kind}Criterion`, `Negative${kind}Criterion`].includes(String(criterion.Type)) || !['Audience', 'AudienceCriterion'].includes(String(row(criterion.Criterion).Type)) || row(criterion.Criterion).AudienceType !== type)) throw new AdportError('PROVIDER_ERROR', 'microsoft: native audience criterion ownership or type mismatch');
    return values.filter(value => value.Status !== 'Deleted');
  }

  private snapshot(value: Row, contextHash: string) { return digest({ contextHash, value }); }

  async list(input: { account_id: string; target: Target; audience_type: AudienceType; after_criterion_id?: string; limit: number }) {
    const current = await this.entity(input.account_id, input.target), values = (await this.query(input.account_id, input.target, input.audience_type)).filter(value => !input.after_criterion_id || BigInt(nativeId(value.Id)) > BigInt(input.after_criterion_id)).sort((a, b) => BigInt(nativeId(a.Id)) < BigInt(nativeId(b.Id)) ? -1 : 1), page = values.slice(0, input.limit), truncated = values.length > page.length;
    return { context: current.context, rows: page.map(value => ({ criterion: value, snapshot_hash: this.snapshot(value, current.context.context_hash) })), truncated, ...(truncated ? { next_cursor: nativeId(page.at(-1)!.Id) } : {}) };
  }

  private async all(account: string, value: Target) {
    const results: Row[] = [];
    for (let i = 0; i < audienceType.options.length; i += 4) results.push(...(await Promise.all(audienceType.options.slice(i, i + 4).map(type => this.query(account, value, type)))).flat());
    return results;
  }

  private async exclusive(account: string, value: Target) {
    let opposite: Target[];
    if (value.type === 'AdGroup') opposite = [{ type: 'Campaign', campaign_id: value.campaign_id }];
    else {
      const result = await this.request(account, 'AdGroups/QueryByCampaignId', { CampaignId: value.campaign_id });
      if (!Object.hasOwn(result, 'AdGroups')) throw new AdportError('PROVIDER_ERROR', 'microsoft: opposite-level audience check lacks the ad-group inventory');
      const groups = rows(result.AdGroups);
      if (groups.length > 50 || new Set(groups.map(value => nativeId(value.Id))).size !== groups.length) throw new AdportError('INVALID_INPUT', 'microsoft: opposite-level audience check exceeds 50 ad groups or contains duplicate IDs; no association submitted');
      opposite = groups.map(group => ({ type: 'AdGroup', campaign_id: value.campaign_id, ad_group_id: nativeId(group.Id) }));
    }
    for (const entity of opposite) if ((await this.all(account, entity)).some(value => String(value.Type).startsWith('Biddable'))) throw new AdportError('INVALID_INPUT', 'microsoft: positive audience targets already exist at the opposite campaign/ad-group level; remove them before changing levels');
  }

  private async confirm(ids: string[], check: () => Promise<boolean>) {
    try { if (await check()) return ids; } catch { /* Accepted writes are never replayed to repair an uncertain readback. */ }
    throw new AdportError('PROVIDER_ERROR', 'microsoft: audience targeting write was accepted but readback was not confirmed; reconcile before retrying', { resourceIds: ids });
  }

  async plan(op: WriteOperation, guard: WriteGuard): Promise<MicrosoftPlan> {
    const expectedKind = op.tool === 'microsoft_add_audience_target' ? 'create' : op.tool === 'microsoft_remove_audience_target' ? 'remove' : 'update';
    if (op.provider !== 'microsoft' || !MICROSOFT_AUDIENCE_TARGETING_WRITES.has(op.tool) || op.kind !== expectedKind) throw new AdportError('INVALID_INPUT', 'microsoft: audience targeting operation kind mismatch');
    const account = op.accountId;
    if (op.tool === 'microsoft_set_audience_target_mode') {
      const input = mode.parse(op.payload), current = await this.entity(account, input.target, true);
      if (current.campaign.CampaignType === 'PerformanceMax') throw new AdportError('INVALID_INPUT', 'microsoft: Performance Max does not support TargetSetting; use campaign exclusions or asset-group signals');
      if (current.context.context_hash !== input.expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'microsoft: audience parent context changed; request a fresh preview');
      if (current.targetSettings.some(setting => Object.entries(setting).some(([key, value]) => !['Type', 'Details'].includes(key) && value !== null && value !== undefined))) throw new AdportError('INVALID_INPUT', 'microsoft: an unsupported target-setting property prevents a safe replacement');
      const details = orderedDetails([...current.details.filter(value => value.CriterionTypeGroup !== 'Audience'), ...(input.target_and_bid ? [{ CriterionTypeGroup: 'Audience', TargetAndBid: true }] : [])]), fields = { Id: entityId(input.target), Settings: [{ Type: 'TargetSetting', Details: details.length ? details : null }] };
      const body = input.target.type === 'Campaign' ? { AccountId: account, Campaigns: [fields] } : { CampaignId: input.target.campaign_id, AdGroups: [fields] };
      return { summary: `Set Microsoft ${input.target.type} "${String(current.entity.Name ?? entityId(input.target))}" audience delivery option`, changes: [`~ ${JSON.stringify(fields)}`, 'Applies to every positive audience on this entity. Other target groups and other settings are preserved; exclusions and serving status are unchanged.'], fieldChanges: [{ field: 'Audience delivery option', before: current.context.audience_target_option, after: input.target_and_bid ? 'TargetAndBid' : 'BidOnly' }], notes: notices, coercions: [], budgetDeltas: [], execute: async () => {
        await this.request(account, input.target.type === 'Campaign' ? 'Campaigns' : 'AdGroups', body, 'PUT');
        return this.confirm([entityId(input.target)], async () => { const after = await this.entity(account, input.target); return after.context.target_and_bid === input.target_and_bid && digest(after.details.filter(value => value.CriterionTypeGroup !== 'Audience')) === digest(current.details.filter(value => value.CriterionTypeGroup !== 'Audience')) && digest(after.settings.filter(value => !isTargetSetting(value))) === digest(current.settings.filter(value => !isTargetSetting(value))) && after.context.campaign_status === current.context.campaign_status && after.context.ad_group_status === current.context.ad_group_status; });
      } };
    }
    if (op.tool === 'microsoft_add_audience_target') {
      const input = add.parse(op.payload), current = await this.entity(account, input.target, true), source = await this.source(account, input.audience_id, input.audience_type);
      if (source.snapshot_hash !== input.expected_audience_snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'microsoft: audience definition changed; read its current snapshot and request a fresh preview');
      if (current.campaign.CampaignType === 'PerformanceMax' && !input.exclude) throw new AdportError('INVALID_INPUT', 'microsoft: Performance Max audience criteria support exclusions only; positive audiences use asset-group signals');
      if (guard.forcePausedCreation && current.campaign.Status !== 'Paused' && current.group?.Status !== 'Paused') throw new AdportError('POLICY_VIOLATION', 'microsoft: audience criteria are natively Active; paused_creation requires a paused campaign or ad group');
      if (!input.exclude && current.context.target_and_bid !== input.expected_target_and_bid) throw new AdportError('PENDING_MISMATCH', 'microsoft: audience target mode changed; request a fresh preview');
      if ((await this.query(account, input.target, input.audience_type)).some(value => nativeId(row(value.Criterion).AudienceId) === input.audience_id)) throw new AdportError('INVALID_INPUT', 'microsoft: this audience is already associated or excluded at the selected level');
      if (!input.exclude) await this.exclusive(account, input.target);
      const kind = prefix(input.target), percent = input.bid_adjustment_percent ?? 0, fields = { [`${kind}Id`]: entityId(input.target), Type: `${input.exclude ? 'Negative' : 'Biddable'}${kind}Criterion`, Criterion: { Type: 'AudienceCriterion', AudienceId: input.audience_id }, ...(!input.exclude ? { CriterionBid: { Type: 'BidMultiplier', Multiplier: percent } } : {}) };
      return { summary: `${input.exclude ? 'Exclude' : 'Associate'} Microsoft audience "${String(source.audience.Name ?? input.audience_id)}"`, changes: [`+ ${JSON.stringify(fields)}`, `Parent audience delivery option remains ${current.context.audience_target_option}. No source-definition, target-mode or parent-status changes.`], fieldChanges: [{ field: 'Audience', before: '(unattached)', after: `${String(source.audience.Name ?? '')} (${input.audience_id})` }, { field: 'Parent', before: '(unattached)', after: `${input.target.type} ${String(current.entity.Name ?? '')} (${entityId(input.target)})` }, { field: 'Association', before: '(none)', after: input.exclude ? 'Exclude' : `${current.context.audience_target_option}, bid adjustment ${percent}%` }], notes: notices, coercions: [], budgetDeltas: [], execute: async () => {
        const result = await this.request(account, `${kind}Criterions`, { [`${kind}Criterions`]: [fields], CriterionType: 'Audience' }), ids = Array.isArray(result[`${kind}CriterionIds`]) ? (result[`${kind}CriterionIds`] as unknown[]).filter(value => value !== null).map(nativeId) : [];
        if (ids.length !== 1) throw new AdportError('PROVIDER_ERROR', 'microsoft: audience criterion receipt mismatch; reconcile before retrying', { resourceIds: ids });
        return this.confirm(ids, async () => { const actual = (await this.query(account, input.target, input.audience_type)).find(value => nativeId(value.Id) === ids[0]); return !!actual && actual.Type === fields.Type && nativeId(row(actual.Criterion).AudienceId) === input.audience_id && (input.exclude || row(actual.CriterionBid).Type === 'BidMultiplier' && row(actual.CriterionBid).Multiplier === percent); });
      } };
    }
    const input = (op.tool === 'microsoft_set_audience_target_bid' ? bid : reference).parse(op.payload), current = await this.entity(account, input.target, true), criterion = (await this.query(account, input.target, input.audience_type)).find(value => nativeId(value.Id) === input.criterion_id);
    if (!criterion) throw new AdportError('INVALID_INPUT', 'microsoft: audience criterion was not found in the selected entity/account/type');
    if (this.snapshot(criterion, current.context.context_hash) !== input.expected_snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'microsoft: audience criterion or parent context changed; request a fresh preview');
    const kind = prefix(input.target);
    if (op.tool === 'microsoft_set_audience_target_bid') {
      const value = bid.parse(input);
      if (criterion.Type !== `Biddable${kind}Criterion` || row(criterion.CriterionBid).Type !== 'BidMultiplier') throw new AdportError('INVALID_INPUT', 'microsoft: only biddable audience criteria with BidMultiplier accept a bid edit');
      const fields = { [`${kind}Id`]: entityId(input.target), Id: input.criterion_id, Type: `Biddable${kind}Criterion`, CriterionBid: { Type: 'BidMultiplier', Multiplier: value.bid_adjustment_percent } };
      return { summary: `Set Microsoft audience ${nativeId(row(criterion.Criterion).AudienceId)} bid adjustment on ${kind} "${String(current.entity.Name ?? entityId(input.target))}"`, changes: [`~ ${JSON.stringify(fields)}`], fieldChanges: [{ field: 'Bid adjustment', before: `${row(criterion.CriterionBid).Multiplier}%`, after: `${value.bid_adjustment_percent}%` }], notes: notices, coercions: [], budgetDeltas: [], execute: async () => {
        await this.request(account, `${kind}Criterions`, { [`${kind}Criterions`]: [fields], CriterionType: 'Audience' }, 'PUT');
        return this.confirm([input.criterion_id], async () => { const actual = (await this.query(account, input.target, input.audience_type)).find(value => nativeId(value.Id) === input.criterion_id); return !!actual && actual.Type === criterion.Type && digest(actual.Criterion) === digest(criterion.Criterion) && row(actual.CriterionBid).Multiplier === value.bid_adjustment_percent; });
      } };
    }
    return { summary: `Remove Microsoft audience association from ${kind} "${String(current.entity.Name ?? entityId(input.target))}"`, changes: [`- ${JSON.stringify(criterion)}`, 'Removing a positive association or an exclusion can change delivery. Parent target mode, status and other criterion IDs are preserved.'], fieldChanges: [{ field: 'Audience association', before: `${String(criterion.Type).startsWith('Negative') ? 'Exclude' : 'Positive'} audience ${nativeId(row(criterion.Criterion).AudienceId)} (criterion ${input.criterion_id})`, after: 'Removed' }], notes: notices, coercions: [], budgetDeltas: [], execute: async () => {
      await this.request(account, `${kind}Criterions`, { [`${kind}Id`]: entityId(input.target), [`${kind}CriterionIds`]: [input.criterion_id], CriterionType: 'Audience' }, 'DELETE');
      return this.confirm([input.criterion_id], async () => !(await this.query(account, input.target, input.audience_type)).some(value => nativeId(value.Id) === input.criterion_id));
    } };
  }
}

export function microsoftAudienceTargetingTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'microsoft_audience_targets', namespace: 'microsoft', description: 'Read campaign or ad-group audience associations/exclusions of one concrete audience type. Returns native criteria, snapshots and verified parent target-mode/status context. Campaign TargetSetting is explicitly requested. Continue next_cursor as after_criterion_id.', input: z.object({ account_id: id, target, audience_type: audienceType, after_criterion_id: id.optional(), limit: z.number().int().positive().max(1000).default(100) }), output: z.object({ context, rows: z.array(z.object({ criterion: z.record(z.string(), z.unknown()), snapshot_hash: hash })), truncated: z.boolean(), next_cursor: id.optional() }), pagination: { cursorInput: 'after_criterion_id' }, annotations: { readOnly: true }, handler: input => provider.audienceTargeting.list(input) }),
    guardedWriteTool({ name: 'microsoft_add_audience_target', namespace: 'microsoft', provider: 'microsoft', kind: 'create', description: 'Associate or exclude an account-available audience with expected_audience_snapshot_hash. Positive criteria require expected_target_and_bid from target reads and a complete opposite-level check, bounded to 50 ad groups. Preserves parent mode/status; native Active criteria require an effectively paused parent under paused_creation. Performance Max supports campaign exclusions only.', payload: add }),
    guardedWriteTool({ name: 'microsoft_set_audience_target_bid', namespace: 'microsoft', provider: 'microsoft', kind: 'update', description: 'Edit an owned positive audience criterion percentage adjustment (-90..900, integer) with expected_snapshot_hash. Preserves audience identity, delivery mode and parent status. Exclusions do not accept bids.', payload: bid }),
    guardedWriteTool({ name: 'microsoft_remove_audience_target', namespace: 'microsoft', provider: 'microsoft', kind: 'remove', description: 'Remove an exact owned audience association/exclusion with expected_snapshot_hash. This can broaden or narrow delivery; preserves target mode and other criteria. Confirms disappearance before reporting success.', payload: reference }),
    guardedWriteTool({ name: 'microsoft_set_audience_target_mode', namespace: 'microsoft', provider: 'microsoft', kind: 'update', description: 'Set TargetAndBid (restrict positive audience delivery) or BidOnly (bid adjustment without that restriction) with expected_context_hash from target reads. Preserves all other target-setting details and other settings; affects all positive audiences on that entity. Performance Max uses signals and exclusions instead.', payload: mode }),
  ];
}
