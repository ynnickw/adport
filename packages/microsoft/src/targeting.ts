import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteGuard, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { MicrosoftNativeService, microsoftId as id, microsoftNativeId as nativeId, microsoftRow as row, microsoftRows as rows, type MicrosoftPlan, type MicrosoftRow as Row } from './native.js';
import type { MicrosoftAdsProvider } from './provider.js';

import { criterionType, target, add, reference, remove, bid, intentUpdate, nativeTarget } from './targeting-schemas.js';

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


  async plan(op: WriteOperation, guard: WriteGuard): Promise<MicrosoftPlan> {
    const expectedKind = op.tool === 'microsoft_add_campaign_targets' ? 'create' : op.tool === 'microsoft_remove_campaign_targets' ? 'remove' : 'update';
    if (op.provider !== 'microsoft' || !MICROSOFT_TARGETING_WRITES.has(op.tool) || op.kind !== expectedKind) throw new AdportError('INVALID_INPUT', 'microsoft: targeting operation kind mismatch');
    if (op.tool === 'microsoft_add_campaign_targets') {
      const input = add.parse(op.payload), campaign = await this.campaign(op.accountId, input.campaign_id), values = input.targets.map(value => nativeTarget({ CampaignId: input.campaign_id }, value));
      if (guard.forcePausedCreation && campaign.Status !== 'Paused') throw new AdportError('POLICY_VIOLATION', 'microsoft: campaign targets are natively Active and cannot be paused; paused_creation requires a paused campaign');
      const seen = new Map<string, Set<string>>();
      for (const [index, value] of values.entries()) {
        const type = input.targets[index]!.type;
        if (!seen.has(type)) seen.set(type, new Set((await this.query(op.accountId, input.campaign_id, type)).map(value => this.key(type, row(value.Criterion)))));
        const key = this.key(type, row(value.Criterion));
        if (seen.get(type)!.has(key)) throw new AdportError('INVALID_INPUT', 'microsoft: this campaign target already exists; use its explicit bid/intent edit or remove it first');
        seen.get(type)!.add(key);
      }
      return { summary: `Add ${values.length} Microsoft campaign target(s)`, changes: [`+ ${JSON.stringify(values)}`, `Campaign ${input.campaign_id} remains ${campaign.Status}. Targets have native Active status; no parent status changes. Bid adjustments are whole percentages, not multipliers.`, 'Location IDs must be current in the geographical file; Microsoft rejects deprecated targets. Schedule timezone follows the native AdScheduleUseSearcherTimeZone flag: searcher or account time. The deprecated campaign TimeZone is not authoritative.'], coercions: [], budgetDeltas: [], execute: async () => {
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
