import { creativesOutput, defineTool, guardedWriteTool, mediaSourceFields, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { MetaAdsProvider } from './provider.js';

const id = z.string().regex(/^\d+$/);
const account = z.string().regex(/^(act_)?\d+$/);
const limit = z.number().int().positive().max(200).default(50);
const objects = z.object({ rows: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean() });
const webUrl = z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol));

export function metaCreativeTools(provider: MetaAdsProvider): AnyToolDefinition[] {
  const write = (name: string, description: string, payload: z.ZodObject<z.ZodRawShape>, kind: 'create' | 'update' | 'remove' = 'update') =>
    guardedWriteTool({ name, namespace: 'meta', provider: 'meta', description, payload, kind });
  return [
    defineTool({ name: 'meta_list_ads', namespace: 'meta', description: 'Read ad configuration and creative copy/media with visual editing actions. Filters are optional; IDs remain bound to the selected account.',
      input: z.object({ account_id: account, campaign_id: id.optional(), ad_set_id: id.optional(), limit }),
      output: creativesOutput.extend({ ads: z.array(z.record(z.string(), z.unknown())) }), presentation: 'creatives', annotations: { readOnly: true },
      handler: input => provider.creatives.listAds(input) }),
    defineTool({ name: 'meta_list_creatives', namespace: 'meta', description: 'Read the selected account creative library, including immutable content, media references and raw creative configuration.',
      input: z.object({ account_id: account, limit }), output: creativesOutput.extend({ raw: z.array(z.record(z.string(), z.unknown())) }),
      presentation: 'creatives', annotations: { readOnly: true }, handler: input => provider.creatives.listCreatives(input) }),
    defineTool({ name: 'meta_list_ad_sets', namespace: 'meta', description: 'Read full ad-set targeting, delivery, bidding, schedules and budgets in minor currency units.',
      input: z.object({ account_id: account, campaign_id: id.optional(), limit }), output: objects, annotations: { readOnly: true },
      handler: input => provider.creatives.listAdSets(input) }),
    ...(['images', 'videos', 'custom_audiences', 'pixels'] as const).map(kind => defineTool({
      name: `meta_list_${kind}`, namespace: 'meta', description: `Read account-owned Meta ${kind.replaceAll('_', ' ')} and their provider configuration.`,
      input: z.object({ account_id: account, limit }), output: kind === 'images' || kind === 'videos' ? objects.extend(creativesOutput.shape) : objects,
      ...(kind === 'images' || kind === 'videos' ? { presentation: 'creatives' as const } : {}), annotations: { readOnly: true },
      handler: input => provider.creatives.library(kind, input),
    })),
    defineTool({ name: 'meta_search_targeting', namespace: 'meta', description: 'Discover interest, location or locale targeting identifiers from Meta targeting search.',
      input: z.object({ account_id: account, type: z.enum(['adinterest', 'adgeolocation', 'adlocale']), query: z.string().min(1), country_code: z.string().length(2).optional(), limit }),
      output: objects, annotations: { readOnly: true }, handler: input => provider.creatives.searchTargeting(input) }),
    defineTool({ name: 'meta_delivery_estimate', namespace: 'meta', description: 'Read Meta delivery estimates for a provider-shaped targeting specification and optimization goal. Estimates are not delivery guarantees.',
      input: z.object({ account_id: account, targeting_spec: z.record(z.string(), z.unknown()), optimization_goal: z.string().min(1) }),
      output: z.object({ estimates: z.array(z.record(z.string(), z.unknown())) }), annotations: { readOnly: true },
      handler: input => provider.creatives.deliveryEstimate(input) }),
    write('meta_create_creative', 'Create an immutable creative from an existing Page post OR provider-shaped object_story_spec (image, video or carousel). Content changes require a new creative, then meta_update_ad to attach it. Does not create or publish an ad.',
      z.object({ name: z.string().min(1), object_story_id: z.string().regex(/^\d+_\d+$/).optional(), object_story_spec: z.record(z.string(), z.unknown()).optional(), url_tags: z.string().optional() })
        .refine(v => Number(Boolean(v.object_story_id)) + Number(Boolean(v.object_story_spec)) === 1, 'Choose exactly one story source'), 'create'),
    write('meta_create_link_creative', 'Create a new image/link creative using an uploaded account image hash and an accessible Facebook Page. Does not replace an existing ad or publish a post.',
      z.object({ name: z.string().min(1), page_id: id, image_hash: z.string().min(1), link: webUrl, message: z.string(), headline: z.string(), description: z.string().optional(), call_to_action: z.string().regex(/^[A-Z][A-Z0-9_]+$/).optional() }), 'create'),
    write('meta_create_ad', 'Create an ad referencing an account-owned ad set and creative. Policy may force PAUSED; parent campaigns and ad sets are unchanged.',
      z.object({ name: z.string().min(1), ad_set_id: id, creative_id: id, status: z.enum(['ACTIVE', 'PAUSED']).default('PAUSED') }), 'create'),
    write('meta_set_ad_status', 'Activate or pause one account-owned ad. Parent delivery settings are unchanged.',
      z.object({ ad_id: id, status: z.enum(['ACTIVE', 'PAUSED']) })),
    write('meta_update_ad', 'Rename an ad or replace its creative with an existing account-owned creative. Serving status is preserved; replacing an active ad may trigger review and change its displayed content.',
      z.object({ ad_id: id, name: z.string().min(1).optional(), creative_id: id.optional() }).refine(v => v.name !== undefined || v.creative_id !== undefined, 'Provide a name or creative_id')),
    write('meta_rename_creative', 'Rename an account-owned creative. Meta creative content is immutable; use meta_create_creative to author a replacement.',
      z.object({ creative_id: id, name: z.string().min(1) })),
    write('meta_delete_creative', 'Permanently delete an account-owned creative. This cannot be undone; review existing ad references before applying.',
      z.object({ creative_id: id }), 'remove'),
    write('meta_delete_image', 'Permanently remove an image hash from the selected account image library. This cannot be undone; review existing creative references before applying.',
      z.object({ image_hash: z.string().min(1) }), 'remove'),
    write('meta_update_targeting', 'Replace one ad set targeting specification after reading its current value. Supply the complete desired targeting object; omitted targeting keys are removed. Budgets and serving status are preserved.',
      z.object({ ad_set_id: id, targeting: z.record(z.string(), z.unknown()).refine(v => Object.keys(v).length > 0, 'Targeting must not be empty') })),
    write('meta_set_ad_set_bidding', 'Edit an account-owned ad set bidding strategy and optional cap/ROAS floor. Bid amounts use minor currency units. Budgets and targeting remain unchanged.',
      z.object({ ad_set_id: id, bid_strategy: z.enum(['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS']), bid_amount: z.number().int().positive().optional(), bid_constraints: z.object({ roas_average_floor: z.number().int().positive() }).optional() })),
    write('meta_create_custom_audience', 'Create an empty customer-list audience container. Does not upload customer data or attach the audience to delivery.',
      z.object({ name: z.string().min(1), description: z.string().optional(), customer_file_source: z.enum(['USER_PROVIDED_ONLY', 'PARTNER_PROVIDED_ONLY', 'BOTH_USER_AND_PARTNER_PROVIDED']) }), 'create'),
    write('meta_create_pixel', 'Create a Meta pixel in the selected ad account. Does not install tracking code or send events.', z.object({ name: z.string().min(1) }), 'create'),
    write('meta_upload_image', 'Upload checksum-bound PNG/JPEG image bytes into the selected ad account image library. Hosted calls require media_id; file_path is local-only. Does not publish an ad.',
      z.object({ ...mediaSourceFields }).refine(v => Number(Boolean(v.media_id)) + Number(Boolean(v.file_path)) === 1, 'Choose media_id or file_path'), 'create'),
    write('meta_upload_video', 'Upload checksum-bound MP4/MOV video bytes into the selected account library. Hosted calls require media_id; file_path is local-only. Video processing continues asynchronously; read meta_list_videos before use.',
      z.object({ ...mediaSourceFields, title: z.string().optional() }).refine(v => Number(Boolean(v.media_id)) + Number(Boolean(v.file_path)) === 1, 'Choose media_id or file_path'), 'create'),
  ];
}
