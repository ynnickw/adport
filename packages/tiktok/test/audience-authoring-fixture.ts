import { customAudienceFixture, CUSTOM_ACCOUNT, CUSTOM_AUDIENCE, NEW_CUSTOM_AUDIENCE } from './custom-audience-fixture.js';
import type { audienceSourceType } from '../src/audience-authoring-schemas.js';
import type { z } from 'zod';

type Row = Record<string, any>;
type Call = { url: URL; init: RequestInit; body?: Row; form?: FormData };
export const SOURCE_IDS = { APP: 'com.synthetic.app', BUSINESS_ACCOUNT: '7001', ENGAGEMENT: '3001', ENGAGEMENT_LIVE_VIDEO: '9001', ENGAGEMENT_ORGANIC_VIDEO: '8001', OFFLINE: 'offline-event-set', PIXEL: '1001', TIKTOK_SHOP: '4001' };
export const sourceIdentity = { identity_id: 'identity-uuid', identity_type: 'BC_AUTH_TT' as const, identity_authorized_bc_id: '6001' };
export function ruleInput(type: z.infer<typeof audienceSourceType> = 'PIXEL'): Row {
  return { audience_type: type, ...(type.includes('VIDEO') ? sourceIdentity : {}), ...(type === 'LEAD_GENERATION' ? { acknowledge_all_event_sources: true } : {}), rule_spec: { inclusion_rule_set: { operator: 'OR', rules: [{ ...(type === 'LEAD_GENERATION' ? {} : { event_source_ids: [SOURCE_IDS[type as keyof typeof SOURCE_IDS]] }), retention_days: 30, filter_set: { operator: 'OR', filters: [{ field: 'EVENT', operator: 'EQ', value: type === 'PIXEL' ? 'PIXEL COMPLETE PAYMENT' : 'Synthetic native event' }] } }] } } };
}
export function audienceAuthoringFixture() {
  const f = customAudienceFixture(), state = {
    apps: [{ app_id: SOURCE_IDS.APP, advertiser_id: CUSTOM_ACCOUNT, app_name: 'QA <script> app', app_platform_id: 'platform_qa', platform: 'IOS', partner: { partner_token: 'PRIVATE-PARTNER' } }] as Row[],
    groups: [{ adgroup_id: SOURCE_IDS.ENGAGEMENT, advertiser_id: CUSTOM_ACCOUNT, campaign_id: '2001', adgroup_name: 'QA ad group' }] as Row[],
    pixels: [{ pixel_id: SOURCE_IDS.PIXEL, advertiser_id: CUSTOM_ACCOUNT, pixel_name: 'QA pixel' }] as Row[],
    offline: [{ event_set_id: SOURCE_IDS.OFFLINE, advertiser_id: CUSTOM_ACCOUNT, name: 'QA offline set', description: 'PRIVATE-OFFLINE' }] as Row[],
    stores: [{ store_id: SOURCE_IDS.TIKTOK_SHOP, store_name: 'QA shop', store_type: 'TIKTOK_SHOP', store_authorized_bc_id: '6001' }] as Row[],
    identities: [{ ...sourceIdentity, available_status: 'AVAILABLE', display_name: 'QA identity', can_pull_video: true, can_use_live_ads: true }] as Row[],
    videos: [{ item_id: SOURCE_IDS.ENGAGEMENT_ORGANIC_VIDEO, item_type: 'VIDEO', status: 'ITEM_STATUS_HESITATE_RECOMMEND', text: 'QA <script> post' }] as Row[],
    live: [{ live_id: SOURCE_IDS.ENGAGEMENT_LIVE_VIDEO, finish_timestamp: '2026-11-01 12:00:00' }] as Row[],
    user: { core_user_id: SOURCE_IDS.BUSINESS_ACCOUNT, display_name: 'Private user', email: 'PRIVATE@example.invalid' } as Row,
    authorized: [CUSTOM_ACCOUNT], echo: 'modern', mutated: false, createdId: NEW_CUSTOM_AUDIENCE, hook: undefined as undefined | ((call: Call) => Response | undefined),
  };
  const ok = (data: unknown) => Response.json({ code: 0, message: 'OK', data });
  f.state.hook = call => {
    const override = state.hook?.(call);if (override) return override;const { url, init, body } = call, path = url.pathname;
    const page = Number(url.searchParams.get('page') ?? 1), size = Number(url.searchParams.get('page_size') ?? 20), paged = (rows: Row[], field: string) => ok({ [field]: rows.slice((page - 1) * size, page * size), page_info: { page, page_size: size, total_page: Math.ceil(rows.length / size), total_number: rows.length } });
    if (path.endsWith('/oauth2/advertiser/get/')) return ok({ list: state.authorized.map(advertiser_id => ({ advertiser_id, advertiser_name: 'QA' })) });
    if (path.endsWith('/app/list/')) return ok({ apps: state.apps });
    if (path.endsWith('/adgroup/get/')) { const ids = JSON.parse(url.searchParams.get('filtering') ?? '{}').adgroup_ids as string[] | undefined;return paged(state.groups.filter(row => !ids || ids.includes(row.adgroup_id)), 'list'); }
    if (path.endsWith('/pixel/list/')) return paged(state.pixels.filter(row => !url.searchParams.has('pixel_id') || row.pixel_id === url.searchParams.get('pixel_id')), 'pixels');
    if (path.endsWith('/offline/get/')) { const ids = url.searchParams.has('event_set_ids') ? JSON.parse(url.searchParams.get('event_set_ids')!) as string[] : undefined;return ok({ event_set_list: state.offline.filter(row => !ids || ids.includes(row.event_set_id)) }); }
    if (path.endsWith('/store/list/')) return ok({ stores: state.stores.filter(row => !url.searchParams.has('store_id') || row.store_id === url.searchParams.get('store_id')) });
    if (path.endsWith('/user/info/')) return ok(state.user);
    if (path.endsWith('/identity/info/')) return ok({ identity_info: state.identities.find(row => row.identity_id === url.searchParams.get('identity_id')) });
    if (path.endsWith('/identity/get/')) return paged(state.identities, 'identity_list');
    if (path.endsWith('/identity/video/get/')) return ok({ video_list: state.videos, cursor: '1780432720000', has_more: false });
    if (path.endsWith('/identity/live/get/')) return ok({ live_list: state.live, cursor: '1686195429', has_more: false });
    if (init.method === 'POST' && (path.endsWith('/custom_audience/rule/create/') || path.endsWith('/custom_audience/lookalike/create/'))) {
      state.mutated = true;const lookalike = path.includes('/lookalike/'), typeMap: Row = { APP: 'App Activity Audience', BUSINESS_ACCOUNT: 'Rule Business Account', ENGAGEMENT: 'Engagement Audience', ENGAGEMENT_LIVE_VIDEO: 'Engagement Audience', ENGAGEMENT_ORGANIC_VIDEO: 'Engagement Audience', LEAD_GENERATION: 'Lead Generation ', OFFLINE: 'Synthetic offline type', PIXEL: 'Website Audience', TIKTOK_SHOP: 'Rule ad shop' };
      const row: Row = { ...f.state.rows[0], audience_id: state.createdId, name: body!.custom_audience_name, type: lookalike ? 'Lookalike Audience' : typeMap[body!.audience_type], calculate_type: null, is_valid: false, is_auto_refresh: body!.is_auto_refresh, lookalike_spec: lookalike ? state.echo === 'legacy' ? null : [{ ...body!.lookalike_spec, placements: body!.lookalike_spec.placements.length === 1 ? body!.lookalike_spec.placements[0] : body!.lookalike_spec.placements, ...(state.echo === 'wrong' ? { include_source: !body!.lookalike_spec.include_source } : {}) }] : null, rule: lookalike ? null : state.echo === 'legacy' ? '{"inclusions":null,"exclusions":null}' : JSON.stringify(state.echo === 'wrong' ? { ...body!.rule_spec, inclusion_rule_set: { ...body!.rule_spec.inclusion_rule_set, rules: [{ ...body!.rule_spec.inclusion_rule_set.rules[0], retention_days: 7 }] } } : body!.rule_spec) };
      f.state.rows.push(row);return ok({ custom_audience_id: state.createdId });
    }
    if (init.method === 'POST' && path.endsWith('/custom_audience/lookalike/update/')) { state.mutated = true;for (const row of f.state.rows) if (body!.custom_audience_ids.includes(row.audience_id)) row.is_valid = false;return ok({}); }
    return undefined;
  };
  const context = (input = ruleInput()) => f.provider.audienceAuthoring.context({ account_id: CUSTOM_ACCOUNT, ...input });
  const createRule = async (input = ruleInput()): Promise<Row> => ({ ...input, custom_audience_name: 'QA rule audience', is_auto_refresh: false, expected_context_hash: (await context(input)).context_hash });
  const lookalike = async () => ({ custom_audience_name: 'QA lookalike', expected_source_snapshot_hash: (await f.get()).audience.snapshot_hash, lookalike_spec: { source_audience_id: CUSTOM_AUDIENCE, include_source: false, mobile_os: 'ALL', placements: ['TikTok'], location_ids: ['DE'], audience_size: 'NARROW' } });
  return { ...f, sourceState: state, context, createRule, lookalike };
}
