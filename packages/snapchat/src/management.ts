import { createHash } from 'node:crypto';
import { AdportError, type WriteGuard, type WriteOperation, type WriteResult } from '@adport/core';
import { z } from 'zod';
import { SnapchatAdsClient } from './client.js';
import { SnapchatCreativeService, type SnapchatPlan } from './creatives.js';
import { audienceUpdate, audienceUsers, conversionCreate, customerAudience, engagementAudience, lookalike, measurementUpdate, mobileAudience, profileAudience, websiteAudience } from './management-tools.js';
import { snapchatId as id } from './schemas.js';

type Row = Record<string, unknown>;
const rowSchema = z.looseObject({ id });
const record = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const sourceType = z.enum(['PIXEL', 'MOBILE_APP']);
function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => matches(actual[index], value));
  if (expected && typeof expected === 'object') return actual !== null && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(expected).every(([key, value]) => matches((actual as Row)[key], value));
  return actual === expected;
}

export class SnapchatManagementService {
  constructor(private readonly client: SnapchatAdsClient, private readonly creatives: SnapchatCreativeService) {}
  async audience(account: string, segment: string) {
    const rows = await this.client.collection(`segments/${id.parse(segment)}`, 'segments', 'segment', rowSchema);
    if (rows.length !== 1 || rows[0]!.id !== segment || rows[0]!.ad_account_id !== id.parse(account)) throw new AdportError('INVALID_INPUT', 'snapchat: audience is not owned by the selected account');
    return rows[0]!;
  }
  async audiences(input: { account_id: string; limit: number; cursor?: string }) {
    return this.client.page(`adaccounts/${id.parse(input.account_id)}/segments`, 'segments', 'segment', rowSchema, { limit: String(input.limit), ...(input.cursor ? { cursor: input.cursor } : {}) });
  }
  async pixels(account: string) {
    const items = await this.client.collection(`adaccounts/${id.parse(account)}/pixels`, 'pixels', 'pixel', rowSchema);
    return { items, truncated: false, setup_note: 'Snap documents Pixel creation in Ads Manager. Reading or renaming a Pixel does not install tracking or send events.' };
  }
  private async source(account: string, type: 'PIXEL' | 'MOBILE_APP', resource: string, requireOwner = false) {
    id.parse(resource);
    if (type === 'PIXEL') {
      const pixel = (await this.pixels(account)).items.find(row => row.id === resource);
      if (!pixel || (requireOwner && pixel.ad_account_id !== account)) throw new AdportError('INVALID_INPUT', 'snapchat: Pixel is not available to, or owned by, the selected account');
      return pixel;
    }
    if (requireOwner) throw new AdportError('INVALID_INPUT', 'snapchat: Snap App custom conversions are shared resources without proven ad-account ownership; deletion is unavailable through this account scope');
    if (!(await this.client.sharingPolicies(account, 'mobile_apps')).some(row => row.source.resource_id === resource)) throw new AdportError('INVALID_INPUT', 'snapchat: Snap App is not available to the selected account');
    return { id: resource };
  }
  async conversions(input: { account_id: string; source_type: 'PIXEL' | 'MOBILE_APP'; source_id: string; limit: number; cursor?: string }) {
    await this.source(input.account_id, input.source_type, input.source_id);
    const path = `${input.source_type === 'PIXEL' ? 'pixels' : 'mobile_apps'}/${input.source_id}/custom_conversions`;
    const data = await this.client.page(path, 'custom_conversions', 'custom_conversion', rowSchema, { limit: String(input.limit), ...(input.cursor ? { cursor: input.cursor } : {}) });
    if (data.items.some(row => record(row.event_source).id !== input.source_id || record(row.event_source).type !== input.source_type)) throw new AdportError('PROVIDER_ERROR', 'snapchat: custom conversion source mismatch');
    return data;
  }
  async audienceSize(account: string, group: string) {
    await this.creatives.owned(account, 'adsquads', group);
    const data = await this.client.request(`adsquads/${group}/audience_size_v2`, 'GET', z.looseObject({ audience_size: z.looseObject({ ad_squad_id: id.optional(), audience_size_minimum: z.number().nonnegative(), audience_size_maximum: z.number().nonnegative() }) }));
    if ((data.audience_size.ad_squad_id && data.audience_size.ad_squad_id !== group) || data.audience_size.audience_size_minimum > data.audience_size.audience_size_maximum) throw new AdportError('PROVIDER_ERROR', 'snapchat: audience-size bounds or ad-squad ID mismatch');
    return data.audience_size;
  }
  private async mutate(account: string, path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: unknown, plural: string, singular: string, expected: Row): Promise<WriteResult> {
    const data = await this.client.mutation(path, method, body, plural, singular, rowSchema), ids = data.items.map(row => row.id), row = data.items[0];
    if (data.items.length !== 1 || !row || (row.ad_account_id !== undefined && row.ad_account_id !== account) || Object.entries(expected).some(([key, value]) => key === 'retention_in_days' ? Number(row[key]) !== value : !matches(row[key], value))) throw new AdportError('PROVIDER_ERROR', 'snapchat: management receipt ownership/value mismatch; reconcile before retrying', { resource_ids: ids, warnings: data.warnings });
    if (['segments', 'pixels'].includes(plural) && row.ad_account_id !== account) throw new AdportError('PROVIDER_ERROR', 'snapchat: management receipt missing account ownership', { resource_ids: ids });
    return { applied: true, resourceIds: ids, ...(data.warnings.length ? { details: { warnings: data.warnings } } : {}) };
  }
  async plan(op: WriteOperation, _guard: WriteGuard): Promise<SnapchatPlan> {
    const account = id.parse(op.accountId), p = op.payload, expectedKind = op.tool.startsWith('snapchat_create_') ? 'create' : /snapchat_(?:delete|remove|clear)_/.test(op.tool) ? 'remove' : 'update';
    if (op.provider !== 'snapchat' || op.kind !== expectedKind) throw new AdportError('INVALID_INPUT', 'snapchat: provider or write kind mismatch');
    let body: Row = {}, path = `adaccounts/${account}/segments`, method: 'POST' | 'PUT' | 'PATCH' = 'POST', plural = 'segments', singular = 'segment', expected: Row = {};
    const notes: string[] = [];
    switch (op.tool) {
      case 'snapchat_create_customer_audience': body = { ...customerAudience.parse(p), source_type: 'FIRST_PARTY' }; break;
      case 'snapchat_create_website_audience': {
        const { events, ...input } = websiteAudience.parse(p); await this.source(account, 'PIXEL', input.pixel_id);
        body = { ...input, source_type: 'PIXEL', prefill: true, pixel_spec_object: { or: { event: events.map(eq => ({ eq })) } } }; break;
      }
      case 'snapchat_create_mobile_audience': {
        const { events, mobile_app_id, ...input } = mobileAudience.parse(p); await this.source(account, 'MOBILE_APP', mobile_app_id);
        body = { ...input, source_type: 'MOBILE', prefill: true, mobile_metadata: { mobile_snapkit_id: mobile_app_id, mobile_app_spec: { or: { event: events.map(eq => ({ eq })) } } } }; break;
      }
      case 'snapchat_create_engagement_audience': {
        const input = engagementAudience.parse(p);
        for (const spec of input.engagement_specs) {
          if (spec.source_type === 'AD_ACCOUNT') { if (spec.source_id !== account) throw new AdportError('INVALID_INPUT', 'snapchat: engagement source belongs to a different account'); }
          else await this.creatives.owned(account, spec.source_type === 'CAMPAIGN' ? 'campaigns' : 'adsquads', spec.source_id);
        }
        body = { ...input, source_type: 'ENGAGEMENT', source_subtype: 'AD_ENGAGEMENT', retention_in_days: 395 }; break;
      }
      case 'snapchat_create_profile_audience': {
        const { profile_id, engagement_type, ...input } = profileAudience.parse(p);
        if (!(await this.client.sharingPolicies(account, 'public_profiles')).some(row => row.source.resource_id === profile_id)) throw new AdportError('INVALID_INPUT', 'snapchat: profile audience source is not available to this account');
        body = { ...input, source_type: 'PROFILE_ENGAGEMENT', creation_spec: { engagement_type, source_profile_id: profile_id } }; break;
      }
      case 'snapchat_create_lookalike': {
        const { seed_segment_id, countries, type, ...input } = lookalike.parse(p), seed = await this.audience(account, seed_segment_id);
        if (!['FIRST_PARTY', 'PROFILE_ENGAGEMENT'].includes(String(seed.source_type))) throw new AdportError('INVALID_INPUT', 'snapchat: this tool supports documented first-party and profile-engagement lookalike seeds');
        body = { ...input, source_type: 'LOOKALIKE', creation_spec: { seed_segment_id, countries, type } }; break;
      }
      case 'snapchat_update_audience': {
        const { segment_id, ...input } = audienceUpdate.parse(p), current = await this.audience(account, segment_id);
        body = { id: segment_id, name: current.name, retention_in_days: current.retention_in_days, ...(current.description !== undefined ? { description: current.description } : {}), ...input };
        const days = Number(body.retention_in_days), maximum = ['LOOKALIKE', 'PROFILE_ENGAGEMENT'].includes(String(current.source_type)) ? 180 : 395;
        if (typeof body.name !== 'string' || !Number.isInteger(days) || days < 1 || (days > maximum && !(current.source_type === 'FIRST_PARTY' && days === 9999)) || (current.source_type === 'ENGAGEMENT' && days !== 395)) throw new AdportError('INVALID_INPUT', 'snapchat: current metadata missing or retention invalid for this audience type');
        body.retention_in_days = days;
        method = 'PUT'; expected = { id: segment_id, name: body.name, retention_in_days: days }; break;
      }
      case 'snapchat_add_audience_users':
      case 'snapchat_remove_audience_users': {
        const input = audienceUsers.parse(p), current = await this.audience(account, input.segment_id);
        if (current.source_type !== 'FIRST_PARTY') throw new AdportError('INVALID_INPUT', 'snapchat: direct membership uploads require an owned FIRST_PARTY audience');
        const remove = op.tool === 'snapchat_remove_audience_users', digest = createHash('sha256').update(JSON.stringify({ schema: input.schema, hashes: input.hashes })).digest('hex');
        return { summary: `${remove ? 'Remove' : 'Add'} ${input.hashes.length} hashed Snapchat audience identifiers`, changes: [`${remove ? 'DELETE' : 'POST'} segments/${input.segment_id}/users; schema ${input.schema}; ${input.hashes.length} identifiers; payload SHA-256 ${digest}. Membership changes affect ads targeting this segment. No identifiers are shown in the preview.`], coercions: [], budgetDeltas: [], execute: async () => {
          const data = await this.client.mutation(`segments/${input.segment_id}/users`, remove ? 'DELETE' : 'POST', { users: [{ ...(remove ? { id: input.segment_id } : {}), schema: [input.schema], data: input.hashes.map(value => [value]) }] }, 'users', 'user', z.object({ number_uploaded_users: z.number().int().nonnegative() }));
          if (data.items.length !== 1 || data.items[0]!.number_uploaded_users !== input.hashes.length) throw new AdportError('PROVIDER_ERROR', 'snapchat: audience upload receipt count mismatch; reconcile before retrying', { resource_ids: [input.segment_id], received_count: data.items[0]?.number_uploaded_users });
          return { applied: true, resourceIds: [input.segment_id], details: { uploaded_identifiers: data.items[0]!.number_uploaded_users, schema: input.schema, payload_sha256: digest, warnings: data.warnings } };
        } };
      }
      case 'snapchat_clear_audience_users': {
        const segment = id.parse(p.segment_id), current = await this.audience(account, segment);
        if (current.source_type !== 'FIRST_PARTY') throw new AdportError('INVALID_INPUT', 'snapchat: clearing members requires an owned FIRST_PARTY audience');
        return { summary: `Remove all members from Snapchat audience ${segment}`, changes: ['Permanently remove all members. Ads targeting this audience stop matching until it is populated again.'], coercions: [], budgetDeltas: [], execute: () => this.mutate(account, `segments/${segment}/all_users`, 'DELETE', undefined, 'segments', 'segment', { id: segment }) };
      }
      case 'snapchat_delete_audience': {
        const segment = id.parse(p.segment_id); await this.audience(account, segment);
        return this.deletion(`segments/${segment}`, 'segments', segment, 'Audience deletion cannot be undone. Existing targeting references can stop matching.');
      }
      case 'snapchat_rename_pixel': {
        const pixelId = id.parse(p.pixel_id); await this.source(account, 'PIXEL', pixelId, true);
        body = { id: pixelId, name: z.string().min(1).max(375).parse(p.name), ad_account_id: account }; plural = 'pixels'; singular = 'pixel'; path = `adaccounts/${account}/pixels`; method = 'PUT'; expected = { id: pixelId, name: body.name }; break;
      }
      case 'snapchat_set_adsquad_measurement': {
        const input = measurementUpdate.parse(p), current = await this.creatives.owned(account, 'adsquads', input.ad_squad_id);
        const patch: Array<{ op: 'add' | 'replace'; path: string; value: unknown }> = [];
        if (input.pixel_id) { await this.source(account, 'PIXEL', input.pixel_id); patch.push({ op: current.pixel_id === undefined ? 'add' : 'replace', path: '/pixel_id', value: input.pixel_id }); expected.pixel_id = input.pixel_id; }
        if (input.mobile_app_id) { await this.source(account, 'MOBILE_APP', input.mobile_app_id); const value = { ...record(current.event_sources), MOBILE_APP: [input.mobile_app_id] }; patch.push({ op: current.event_sources === undefined ? 'add' : 'replace', path: '/event_sources', value }); expected.event_sources = value; }
        expected.id = input.ad_squad_id; expected.campaign_id = current.campaign_id;
        return { summary: `Associate Snapchat ad-squad measurement ${input.ad_squad_id}`, changes: [`PATCH ${JSON.stringify(patch)}. This does not install tracking or send events.`], coercions: [], budgetDeltas: [], execute: () => this.mutate(account, `campaigns/${current.campaign_id}/adsquads/${input.ad_squad_id}`, 'PATCH', patch, 'adsquads', 'adsquad', expected) };
      }
      case 'snapchat_create_custom_conversion': {
        const { source_type, source_id, ...input } = conversionCreate.parse(p); await this.source(account, source_type, source_id);
        body = input; plural = 'custom_conversions'; singular = 'custom_conversion'; path = `${source_type === 'PIXEL' ? 'pixels' : 'mobile_apps'}/${source_id}/custom_conversions`; expected = { event_source: { id: source_id, type: source_type }, name: input.name, event_type: input.event_type, rules: input.rules };
        notes.push('Create a new shared-source measurement definition only. No tracking code is installed or conversion event sent.'); break;
      }
      case 'snapchat_delete_custom_conversion': {
        const conversion = id.parse(p.custom_conversion_id), rows = await this.client.collection(`custom_conversions/${conversion}`, 'custom_conversions', 'custom_conversion', rowSchema), current = rows[0];
        if (rows.length !== 1 || current?.id !== conversion) throw new AdportError('PROVIDER_ERROR', 'snapchat: custom conversion ID mismatch');
        const source = record(current.event_source); await this.source(account, sourceType.parse(source.type), id.parse(source.id), true);
        return this.deletion(`custom_conversions/${conversion}`, 'custom_conversions', conversion, 'Permanently delete this source’s custom conversion definition. Reporting and optimization referencing it may be affected.');
      }
      default: throw new AdportError('INVALID_INPUT', `snapchat: unsupported write ${op.tool}`);
    }
    if (plural === 'segments') { body.ad_account_id = account; expected = { ...expected, ...(body.source_type ? { source_type: body.source_type } : {}), ...(body.name ? { name: body.name } : {}), ...(body.retention_in_days !== undefined ? { retention_in_days: Number(body.retention_in_days) } : {}) }; }
    return { summary: `Snapchat ${op.tool.replace('snapchat_', '').replaceAll('_', ' ')}`, changes: [...notes, `${method} ${path}: ${JSON.stringify({ [plural]: [body] })}`], coercions: [], budgetDeltas: [], execute: () => this.mutate(account, path, method, { [plural]: [body] }, plural, singular, expected) };
  }
  private deletion(path: string, plural: string, resourceId: string, description: string): SnapchatPlan {
    return { summary: `Delete Snapchat ${path}`, changes: [description, `DELETE ${path}`], coercions: [], budgetDeltas: [], execute: async () => {
      const data = await this.client.request(path, 'DELETE', z.looseObject({ [plural]: z.array(z.unknown()) }));
      if ((data[plural] as unknown[]).length) throw new AdportError('PROVIDER_ERROR', 'snapchat: unexpected deletion receipt; reconcile before retrying', { resource_ids: [resourceId] });
      return { applied: true, resourceIds: [resourceId] };
    } };
  }
}
