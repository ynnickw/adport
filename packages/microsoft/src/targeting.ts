import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteGuard, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { MicrosoftNativeService, microsoftId as id, microsoftNativeId as nativeId, microsoftRow as row, microsoftRows as rows, type MicrosoftPlan, type MicrosoftRow as Row } from './native.js';
import type { MicrosoftAdsProvider } from './provider.js';

const criterionType = z.enum(['Age', 'Gender', 'Device', 'DayTime', 'Location', 'LocationIntent', 'Radius']);
const bidType = criterionType.exclude(['LocationIntent']);
const adjustment = z.number().int().min(-90).max(900);
const deviceAdjustment = z.number().int().min(-100).max(900);
const minute = z.enum(['Zero', 'Fifteen', 'Thirty', 'FortyFive']);
const intent = z.enum(['PeopleIn', 'PeopleInOrSearchingForOrViewingPages']);
const target = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Age'), age_range: z.enum(['EighteenToTwentyFour', 'TwentyFiveToThirtyFour', 'ThirtyFiveToFourtyNine', 'FiftyToSixtyFour', 'SixtyFiveAndAbove', 'ThirtyFiveToFiftyFour', 'FiftyFiveAndAbove', 'Unknown']), bid_adjustment_percent: adjustment.default(0) }),
  z.object({ type: z.literal('Gender'), gender: z.enum(['Male', 'Female']), bid_adjustment_percent: adjustment.default(0) }),
  z.object({ type: z.literal('Device'), device_name: z.enum(['Computers', 'Smartphones', 'Tablets']), bid_adjustment_percent: deviceAdjustment.default(0) }),
  z.object({ type: z.literal('DayTime'), day: z.enum(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']), from_hour: z.number().int().min(0).max(23), from_minute: minute, to_hour: z.number().int().min(0).max(24), to_minute: minute, bid_adjustment_percent: adjustment.default(0) }),
  z.object({ type: z.literal('Location'), location_id: id, exclude: z.boolean().default(false), bid_adjustment_percent: adjustment.optional() }),
  z.object({ type: z.literal('LocationIntent'), intent_option: intent }),
  z.object({ type: z.literal('Radius'), latitude: z.number().min(-85).max(85), longitude: z.number().min(-180).max(180), radius: z.number().int().positive().max(800), radius_unit: z.enum(['Miles', 'Kilometers']), name: z.string().max(50).optional(), bid_adjustment_percent: adjustment.default(0) }),
]);
const minutes = { Zero: 0, Fifteen: 15, Thirty: 30, FortyFive: 45 };
const add = z.object({ campaign_id: id, targets: z.array(target).min(1).max(100) }).superRefine((value, ctx) => {
  const devices = value.targets.filter(value => value.type === 'Device');
  if (devices.length && (devices.length !== 3 || new Set(devices.map(value => value.device_name)).size !== 3 || devices.every(value => value.bid_adjustment_percent === -100))) ctx.addIssue({ code: 'custom', message: 'Add all three distinct device types together, leaving at least one device included' });
  for (const item of value.targets) {
    if (item.type === 'Location' && item.exclude && item.bid_adjustment_percent !== undefined) ctx.addIssue({ code: 'custom', message: 'Excluded locations cannot have a bid adjustment' });
    if (item.type === 'Radius' && item.radius_unit === 'Miles' && item.radius > 500) ctx.addIssue({ code: 'custom', message: 'Radius in miles cannot exceed 500' });
    if (item.type === 'DayTime' && (item.to_hour === 24 && item.to_minute !== 'Zero' || item.from_hour * 60 + minutes[item.from_minute] >= item.to_hour * 60 + minutes[item.to_minute])) ctx.addIssue({ code: 'custom', message: 'DayTime must end after its start within one day; hour 24 requires minute Zero' });
  }
});
const reference = z.object({ campaign_id: id, criterion_id: id, criterion_type: criterionType });
// Native code2965 forbids deleting LocationIntent; restore its default through the edit tool.
const remove = z.object({ campaign_id: id, criterion_type: criterionType.exclude(['LocationIntent']), criterion_ids: z.array(id).min(1).max(100).refine(value => new Set(value).size === value.length, 'Criterion IDs must be unique') });
const bid = reference.extend({ criterion_type: bidType, bid_adjustment_percent: deviceAdjustment, expected_current_percent: z.number() }).superRefine((value, ctx) => {
  if (value.criterion_type !== 'Device' && value.bid_adjustment_percent < -90) ctx.addIssue({ code: 'custom', message: 'Only devices support a bid adjustment below -90 percent' });
});
const intentUpdate = z.object({ campaign_id: id, criterion_id: id, intent_option: intent, expected_current_intent: intent });
export const MICROSOFT_TARGETING_WRITES = new Set(['microsoft_add_campaign_targets', 'microsoft_set_campaign_target_bid', 'microsoft_set_campaign_location_intent', 'microsoft_remove_campaign_targets']);

/** Native REST uses concrete read selectors, Targets mutation selector and percentage bid adjustments. */
export class MicrosoftTargetingService extends MicrosoftNativeService {
  private subtype(value: Row) { return criterionType.parse(String(row(value.Criterion).Type).replace(/Criterion$/, '')); }

  private key(type: z.infer<typeof criterionType>, criterion: Row) {
    const keys: Record<z.infer<typeof criterionType>, string[]> = { Age: ['AgeRange'], Gender: ['GenderType'], Device: ['DeviceName'], DayTime: ['Day', 'FromHour', 'FromMinute', 'ToHour', 'ToMinute'], Location: ['LocationId'], LocationIntent: [], Radius: ['LatitudeDegrees', 'LongitudeDegrees', 'Radius', 'RadiusUnit'] };
    return JSON.stringify(keys[type].map(key => String(criterion[key] ?? '')));
  }

  private async confirm(criterion: string | string[], change: string, check: () => Promise<boolean>) {
    try { if (await check()) return; } catch { /* An accepted mutation is not retried when readback is unavailable. */ }
    throw new AdportError('PROVIDER_ERROR', `microsoft: ${change} was not confirmed; reconcile before retrying`, { resourceIds: Array.isArray(criterion) ? criterion : [criterion] });
  }

  private async query(account: string, campaign: string, type: z.infer<typeof criterionType>) {
    const result = await this.request(account, 'CampaignCriterions/QueryByIds', { CampaignId: campaign, CampaignCriterionIds: null, CriterionType: type });
    if (!Object.hasOwn(result, 'CampaignCriterions')) throw new AdportError('PROVIDER_ERROR', 'microsoft: campaign targeting was not returned');
    const values = rows(result.CampaignCriterions);
    if (values.some(value => nativeId(value.CampaignId) !== campaign || this.subtype(value) !== type || !['BiddableCampaignCriterion', 'NegativeCampaignCriterion'].includes(String(value.Type)))) throw new AdportError('PROVIDER_ERROR', 'microsoft: campaign target identity mismatch');
    if (new Set(values.map(value => nativeId(value.Id))).size !== values.length) throw new AdportError('PROVIDER_ERROR', 'microsoft: duplicate campaign criterion IDs');
    return values;
  }

  async list(input: { account_id: string; campaign_id: string; criterion_type: z.infer<typeof criterionType> }) {
    await this.campaign(input.account_id, input.campaign_id);
    return { rows: await this.query(input.account_id, input.campaign_id, input.criterion_type), truncated: false };
  }

  private async owned(account: string, input: z.infer<typeof reference>) {
    await this.campaign(account, input.campaign_id);
    const result = (await this.query(account, input.campaign_id, input.criterion_type)).find(value => nativeId(value.Id) === input.criterion_id);
    if (!result) throw new AdportError('INVALID_INPUT', 'microsoft: target was not found with this type in the selected campaign/account');
    return result;
  }

  async geoFile(input: { account_id: string; language_locale: string }) {
    const result = await this.request(input.account_id, 'GeoLocationsFileUrl/Query', { Version: '2.0', LanguageLocale: input.language_locale });
    return z.object({ FileUrl: z.string().url(), FileUrlExpiryTimeUtc: z.string(), LastModifiedTimeUtc: z.string() }).parse(result);
  }

  private nativeTarget(campaign: string, input: z.infer<typeof target>): Row {
    const criterion: Row = { Type: `${input.type}Criterion` };
    if (input.type === 'Age') criterion.AgeRange = input.age_range;
    if (input.type === 'Gender') criterion.GenderType = input.gender;
    if (input.type === 'Device') criterion.DeviceName = input.device_name;
    if (input.type === 'DayTime') Object.assign(criterion, { Day: input.day, FromHour: input.from_hour, FromMinute: input.from_minute, ToHour: input.to_hour, ToMinute: input.to_minute });
    if (input.type === 'Location') criterion.LocationId = input.location_id;
    if (input.type === 'LocationIntent') criterion.IntentOption = input.intent_option;
    // REST long values are decimal strings, including Radius (live-verified).
    if (input.type === 'Radius') Object.assign(criterion, { LatitudeDegrees: input.latitude, LongitudeDegrees: input.longitude, Radius: String(input.radius), RadiusUnit: input.radius_unit, ...(input.name !== undefined ? { Name: input.name } : {}) });
    const excluded = input.type === 'Location' && input.exclude;
    return { CampaignId: campaign, Type: excluded ? 'NegativeCampaignCriterion' : 'BiddableCampaignCriterion', Criterion: criterion, ...(!excluded && input.type !== 'LocationIntent' ? { CriterionBid: { Type: 'BidMultiplier', Multiplier: input.bid_adjustment_percent ?? 0 } } : {}) };
  }

  async plan(op: WriteOperation, guard: WriteGuard): Promise<MicrosoftPlan> {
    const expectedKind = op.tool === 'microsoft_add_campaign_targets' ? 'create' : op.tool === 'microsoft_remove_campaign_targets' ? 'remove' : 'update';
    if (op.provider !== 'microsoft' || !MICROSOFT_TARGETING_WRITES.has(op.tool) || op.kind !== expectedKind) throw new AdportError('INVALID_INPUT', 'microsoft: targeting operation kind mismatch');
    if (op.tool === 'microsoft_add_campaign_targets') {
      const input = add.parse(op.payload), campaign = await this.campaign(op.accountId, input.campaign_id), values = input.targets.map(value => this.nativeTarget(input.campaign_id, value));
      if (guard.forcePausedCreation && campaign.Status !== 'Paused') throw new AdportError('POLICY_VIOLATION', 'microsoft: campaign targets are natively Active and cannot be paused; paused_creation requires a paused campaign');
      const seen = new Map<string, Set<string>>();
      for (const [index, value] of values.entries()) {
        const type = input.targets[index]!.type;
        if (!seen.has(type)) seen.set(type, new Set((await this.query(op.accountId, input.campaign_id, type)).map(value => this.key(type, row(value.Criterion)))));
        const key = this.key(type, row(value.Criterion));
        if (seen.get(type)!.has(key)) throw new AdportError('INVALID_INPUT', 'microsoft: this campaign target already exists; use its explicit bid/intent edit or remove it first');
        seen.get(type)!.add(key);
      }
      return { summary: `Add ${values.length} Microsoft campaign target(s)`, changes: [`+ ${JSON.stringify(values)}`, `Campaign ${input.campaign_id} remains ${campaign.Status}. Targets have native Active status; no parent status changes. Bid adjustments are whole percentages, not multipliers.`, 'Location IDs must be current in the geographical file; Microsoft rejects deprecated targets. DayTime uses the campaign time zone.'], coercions: [], budgetDeltas: [], execute: async () => {
        const result = await this.request(op.accountId, 'CampaignCriterions', { CampaignCriterions: values, CriterionType: 'Targets' });
        const created = Array.isArray(result.CampaignCriterionIds) ? result.CampaignCriterionIds.filter(value => value !== null).map(nativeId) : [];
        if (created.length !== values.length || new Set(created).size !== created.length) throw new AdportError('PROVIDER_ERROR', 'microsoft: target creation receipt mismatch; reconcile before retrying', { resourceIds: created });
        try {
          const byType = new Map<string, Row[]>();
          for (const [index, expected] of values.entries()) {
            const type = input.targets[index]!.type;
            if (!byType.has(type)) byType.set(type, await this.query(op.accountId, input.campaign_id, type));
            const actual = byType.get(type)!.find(value => nativeId(value.Id) === created[index]);
            if (!actual || actual.Type !== expected.Type) throw new Error('Created target missing');
            const actualCriterion = row(actual.Criterion);
            for (const [key, value] of Object.entries(row(expected.Criterion))) if (key !== 'Type' && (key === 'LocationId' ? nativeId(actualCriterion[key]) !== value : actualCriterion[key] !== value)) throw new Error('Created target content mismatch');
            if (expected.CriterionBid && row(actual.CriterionBid).Multiplier !== row(expected.CriterionBid).Multiplier) throw new Error('Created target bid mismatch');
          }
        } catch { throw new AdportError('PROVIDER_ERROR', 'microsoft: targets were accepted but native readback was not confirmed; reconcile before retrying', { resourceIds: created }); }
        return created;
      } };
    }
    if (op.tool === 'microsoft_set_campaign_target_bid') {
      const input = bid.parse(op.payload), current = await this.owned(op.accountId, input);
      if (current.Type !== 'BiddableCampaignCriterion' || row(current.CriterionBid).Type !== 'BidMultiplier') throw new AdportError('INVALID_INPUT', 'microsoft: only biddable campaign targets with BidMultiplier support this edit');
      if (row(current.CriterionBid).Multiplier !== input.expected_current_percent) throw new AdportError('PENDING_MISMATCH', 'microsoft: target bid changed; request a fresh preview');
      const value = { CampaignId: input.campaign_id, Id: input.criterion_id, Type: 'BiddableCampaignCriterion', CriterionBid: { Type: 'BidMultiplier', Multiplier: input.bid_adjustment_percent } };
      return { summary: `Set Microsoft ${input.criterion_type} target bid adjustment`, changes: [`~ ${input.criterion_id}: ${input.expected_current_percent}% → ${input.bid_adjustment_percent}%`, 'Changes the percentage adjustment, preserving the criterion and campaign serving status. Automated bidding may use this as a signal rather than a direct override.'], coercions: [], budgetDeltas: [], execute: async () => {
        await this.request(op.accountId, 'CampaignCriterions', { CampaignCriterions: [value], CriterionType: 'Targets' }, 'PUT');
        await this.confirm(input.criterion_id, 'target bid update', async () => row((await this.owned(op.accountId, input)).CriterionBid).Multiplier === input.bid_adjustment_percent);
        return [input.criterion_id];
      } };
    }
    if (op.tool === 'microsoft_set_campaign_location_intent') {
      const input = intentUpdate.parse(op.payload), reference = { ...input, criterion_type: 'LocationIntent' as const }, current = await this.owned(op.accountId, reference);
      if (current.Type !== 'BiddableCampaignCriterion' || row(current.Criterion).IntentOption !== input.expected_current_intent) throw new AdportError('PENDING_MISMATCH', 'microsoft: location intent changed; request a fresh preview');
      const value = { CampaignId: input.campaign_id, Id: input.criterion_id, Type: 'BiddableCampaignCriterion', Criterion: { Type: 'LocationIntentCriterion', IntentOption: input.intent_option } };
      return { summary: 'Update Microsoft campaign location intent', changes: [`~ ${input.criterion_id}: ${input.expected_current_intent} → ${input.intent_option}`, 'No bid is sent: Microsoft ignores bid multipliers for location intent. Campaign status is preserved.'], coercions: [], budgetDeltas: [], execute: async () => {
        await this.request(op.accountId, 'CampaignCriterions', { CampaignCriterions: [value], CriterionType: 'Targets' }, 'PUT');
        await this.confirm(input.criterion_id, 'location intent update', async () => row((await this.owned(op.accountId, reference)).Criterion).IntentOption === input.intent_option);
        return [input.criterion_id];
      } };
    }
    const input = remove.parse(op.payload);
    await this.campaign(op.accountId, input.campaign_id);
    const current = await this.query(op.accountId, input.campaign_id, input.criterion_type), selected = input.criterion_ids.map(id => current.find(value => nativeId(value.Id) === id));
    if (selected.some(value => !value)) throw new AdportError('INVALID_INPUT', 'microsoft: a target was not found with this type in the selected campaign/account');
    // Native code2957 requires the complete set on deletion too, not just creation.
    if (input.criterion_type === 'Device' && (input.criterion_ids.length !== 3 || current.length !== 3 || !['Computers', 'Smartphones', 'Tablets'].every(name => current.some(value => row(value.Criterion).DeviceName === name)))) throw new AdportError('INVALID_INPUT', 'microsoft: remove all three device criterion IDs together (Computers, Smartphones, Tablets)');
    return { summary: `Remove ${input.criterion_ids.length} Microsoft ${input.criterion_type} campaign target(s)`, changes: [`- ${JSON.stringify(selected)}`, 'Removing a target or exclusion can broaden or narrow delivery for this campaign. Other criterion IDs and parent serving status are preserved.'], coercions: [], budgetDeltas: [], execute: async () => {
      await this.request(op.accountId, 'CampaignCriterions', { CampaignId: input.campaign_id, CampaignCriterionIds: input.criterion_ids, CriterionType: 'Targets' }, 'DELETE');
      await this.confirm(input.criterion_ids, 'target removal', async () => !(await this.query(op.accountId, input.campaign_id, input.criterion_type)).some(value => input.criterion_ids.includes(nativeId(value.Id)) && value.Status !== 'Deleted'));
      return input.criterion_ids;
    } };
  }
}

export function microsoftTargetingTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'microsoft_campaign_targets', namespace: 'microsoft', description: 'Read one concrete campaign targeting subtype with verified campaign/account ownership. Native criterion and percent bid adjustments are preserved. Targets is a mutation selector and cannot be used for reads.', input: z.object({ account_id: id, campaign_id: id, criterion_type: criterionType }), output: z.object({ rows: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean() }), annotations: { readOnly: true }, handler: input => provider.targeting.list(input) }),
    defineTool({ name: 'microsoft_geo_locations_file', namespace: 'microsoft', description: 'Get the native geographical-location file URL, server expiration and modification time. Use current non-deprecated location IDs for targeting; returns metadata without downloading or caching the file.', input: z.object({ account_id: id, language_locale: z.enum(['zh-Hant', 'en', 'fr', 'de', 'it', 'ja-JP', 'pt-BR', 'es']).default('en') }), annotations: { readOnly: true }, handler: input => provider.targeting.geoFile(input) }),
    guardedWriteTool({ name: 'microsoft_add_campaign_targets', namespace: 'microsoft', provider: 'microsoft', kind: 'create', description: 'Add age, gender, device, day/time, location, location-intent or radius targets; locations can be excluded. Native targets are Active; default paused_creation requires a paused campaign. Device creation requires all three device types together. Bids are integer percent adjustments.', payload: add }),
    guardedWriteTool({ name: 'microsoft_set_campaign_target_bid', namespace: 'microsoft', provider: 'microsoft', kind: 'update', description: 'Change a biddable target percentage adjustment with an expected current value. Device range -100..900; other supported targets -90..900. Excluded locations and location-intent criteria do not accept bids.', payload: bid }),
    guardedWriteTool({ name: 'microsoft_set_campaign_location_intent', namespace: 'microsoft', provider: 'microsoft', kind: 'update', description: 'Change campaign location intent with an expected current value. PeopleInOrSearchingForOrViewingPages restores the API default; this criterion cannot be deleted. Preserves status and omits the inapplicable bid multiplier.', payload: intentUpdate }),
    guardedWriteTool({ name: 'microsoft_remove_campaign_targets', namespace: 'microsoft', provider: 'microsoft', kind: 'remove', description: 'Remove exact owned criterion IDs of one subtype. Devices require all three IDs together. Location intent cannot be deleted; use its edit tool instead. Other targets remain; removing restrictions can broaden delivery. Confirms native disappearance.', payload: remove }),
  ];
}
