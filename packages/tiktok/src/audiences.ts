import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { TikTokClient } from './client.js';
import type { TikTokAdsProvider } from './provider.js';

const id = z.string().regex(/^\d+$/);
const nativeId = z.union([id, z.number().int().positive().safe()]).transform(String);
const ids = z.array(id).refine(values => new Set(values).size === values.length, 'IDs must be unique');
const strings = z.array(z.string().min(1));
const name = z.string().trim().min(1).max(512).refine(value => !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3\x00-\x1f\x7f]/u.test(value), 'Saved audience names cannot contain emoji or control characters');
const actions = z.object({
  action_category_ids: ids.min(1), action_period: z.union([z.literal(0), z.literal(7), z.literal(15)]),
  action_scene: z.enum(['VIDEO_RELATED', 'CREATOR_RELATED', 'HASHTAG_RELATED']),
  video_user_actions: strings.min(1),
}).strict().refine(value => value.video_user_actions.every(action => ({ VIDEO_RELATED: ['WATCHED_TO_END', 'LIKED', 'COMMENTED', 'SHARED'], CREATOR_RELATED: ['FOLLOWING', 'VIEW_HOMEPAGE'], HASHTAG_RELATED: ['VIEW_HASHTAG'] })[value.action_scene].includes(action)), 'Action values must match their action scene');
export const savedAudienceCreate = z.object({
  saved_audience_name: name, location_ids: ids.min(1), actions: z.array(actions).optional(),
  age_groups: strings.optional(), audience_ids: ids.optional(), excluded_audience_ids: ids.optional(),
  carrier_ids: ids.optional(), device_model_ids: ids.optional(), device_price_ranges: z.array(z.number().int().safe()).optional(),
  gender: z.enum(['GENDER_FEMALE', 'GENDER_MALE', 'GENDER_UNLIMITED']).optional(),
  interest_category_ids: ids.optional(), interest_keyword_ids: ids.optional(), languages: strings.optional(),
  min_android_version: z.string().min(1).optional(), min_ios_version: z.string().min(1).optional(),
  network_types: strings.optional(), operating_systems: z.array(z.enum(['ANDROID', 'IOS'])).max(1).optional(),
}).strict().refine(value => !(value.device_model_ids?.length && value.device_price_ranges?.length), 'Device model and device price targeting cannot be combined');
const target = z.object({ saved_audience_id: id, expected_snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const savedAudienceDelete = z.object({ targets: z.array(target).min(1).max(100).refine(values => new Set(values.map(value => value.saved_audience_id)).size === values.length, 'Targets must be unique') }).strict();
export const savedAudienceList = z.object({ account_id: id, saved_audience_ids: ids.min(1).max(100).optional(), page: z.number().int().positive().safe().default(1), page_size: z.number().int().positive().max(100).default(10) });
const row = z.looseObject({ saved_audience_id: nativeId, saved_audience_name: z.string(), advertiser_id: nativeId.optional() });
const pageInfo = z.looseObject({ page: z.number().int().positive().safe(), page_size: z.number().int().positive().max(100), total_number: z.number().int().nonnegative().safe().optional(), total_page: z.number().int().nonnegative().safe().optional() });
const response = z.looseObject({ saved_audiences: z.array(row), page_info: pageInfo.optional() });
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const snapshot = (account: string, value: z.infer<typeof row>) => digest({ account_id: account, audience: value });
const notes = ['Local preview only. A saved targeting template does not create or change ads, campaigns, budgets or delivery.', 'TikTok permissions and targeting eligibility remain authoritative. No automatic write retry; reconcile the ID or filtered list after an uncertain outcome.'];

/** Wire contracts: TikTok-owned SDK/OpenAPI f809c396, dmp/saved_audience/{list,create,delete}. */
export class TikTokAudienceService {
  constructor(private readonly client: TikTokClient) {}

  async list(raw: z.input<typeof savedAudienceList>) {
    const input = savedAudienceList.parse(raw);
    const parsed = response.safeParse(await this.client.get('dmp/saved_audience/list', { advertiser_id: input.account_id, saved_audience_ids: input.saved_audience_ids, page: input.page, page_size: input.page_size }));
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'tiktok: saved-audience response shape could not be verified');
    const data = parsed.data, records = data.saved_audiences;
    if (records.length > input.page_size || new Set(records.map(item => item.saved_audience_id)).size !== records.length || records.some(item => item.advertiser_id !== undefined && item.advertiser_id !== input.account_id || input.saved_audience_ids && !input.saved_audience_ids.includes(item.saved_audience_id))) throw new AdportError('PROVIDER_ERROR', 'tiktok: saved-audience response does not match the selected advertiser, IDs or page size');
    const page = data.page_info;
    if (page && (page.page !== input.page || page.page_size !== input.page_size)) throw new AdportError('PROVIDER_ERROR', 'tiktok: saved-audience pagination does not match the requested page');
    const contradictory = page && (page.total_number !== undefined && page.total_number < records.length || page.total_page !== undefined && page.total_page < input.page && records.length > 0);
    const complete = !page || contradictory || page.total_page === undefined ? null : input.page >= page.total_page;
    return { ...data, saved_audiences: records.map(item => ({ ...item, snapshot_hash: snapshot(input.account_id, item) })), complete, truncated: complete !== true,
      ...(complete === false ? { next_page: input.page + 1 } : {}),
      ...(!page || contradictory || page.total_page === undefined ? { pagination_note: 'Native pagination is missing or contradictory; completeness is unknown.' } : {}),
    };
  }

  async get(account: string, audienceId: string) {
    const result = await this.list({ account_id: account, saved_audience_ids: [audienceId], page: 1, page_size: 100 });
    const audience = result.saved_audiences.find(item => item.saved_audience_id === audienceId);
    if (!audience && result.complete !== true) throw new AdportError('PROVIDER_ERROR', 'tiktok: saved-audience lookup could not confirm absence; inspect native pagination before another operation');
    if (!audience) throw new AdportError('INVALID_INPUT', 'tiktok: saved audience was not found in the selected advertiser');
    return { audience };
  }

  async plan(op: WriteOperation): Promise<Plan> {
    if (op.tool === 'tiktok_create_saved_audience') {
      const input = savedAudienceCreate.parse(op.payload), coercions: string[] = [];
      const body = { ...input, ...(input.actions ? { actions: input.actions.map((item, index) => {
        if (item.action_scene !== 'VIDEO_RELATED' && item.action_period !== 0) { coercions.push(`actions[${index}].action_period coerced to 0 for ${item.action_scene} by TikTok`); return { ...item, action_period: 0 }; }
        return item;
      }) } : {}), advertiser_id: op.accountId };
      return { summary: `Create TikTok saved audience "${input.saved_audience_name}"`, changes: [`+ Saved targeting template ${JSON.stringify(body)}`], notes, coercions, budgetDeltas: [], execute: async () => {
        const result = z.looseObject({ saved_audience_id: nativeId }).safeParse(await this.client.post('dmp/saved_audience/create', body));
        if (!result.success) throw new AdportError('PROVIDER_ERROR', 'tiktok: creation did not return a verified saved-audience ID; inspect the advertiser list before another create');
        const audienceId = result.data.saved_audience_id;
        try {
          const actual = (await this.get(op.accountId, audienceId)).audience;
          if (!Object.entries(body).filter(([key]) => key !== 'advertiser_id').every(([key, value]) => canonical((actual as Record<string, unknown>)[key]) === canonical(value))) throw new Error('Targeting readback differs');
        } catch { throw new AdportError('PROVIDER_ERROR', 'tiktok: saved-audience creation readback unconfirmed; reconcile the returned ID before any new create', { resource_ids: [audienceId] }); }
        return [audienceId];
      } };
    }
    if (op.tool !== 'tiktok_delete_saved_audiences') throw new AdportError('INVALID_INPUT', 'tiktok: unsupported saved-audience operation');
    const input = savedAudienceDelete.parse(op.payload), audienceIds = input.targets.map(item => item.saved_audience_id);
    const current = await this.list({ account_id: op.accountId, saved_audience_ids: audienceIds, page: 1, page_size: 100 });
    const selected = input.targets.map(item => {
      const found = current.saved_audiences.find(value => value.saved_audience_id === item.saved_audience_id);
      if (!found || found.snapshot_hash !== item.expected_snapshot_hash) throw new AdportError('INVALID_INPUT', 'tiktok: a saved audience is missing or changed; read its current snapshot before a new preview');
      return found;
    });
    return { summary: `Permanently delete ${selected.length} TikTok saved audience(s)`, changes: selected.map(item => `- ${item.saved_audience_id}: ${item.saved_audience_name}. No native restore endpoint.`), notes, coercions: [], budgetDeltas: [], execute: async () => {
      await this.client.post('dmp/saved_audience/delete', { advertiser_id: op.accountId, saved_audience_ids: audienceIds });
      try {
        const remaining = await this.list({ account_id: op.accountId, saved_audience_ids: audienceIds, page: 1, page_size: 100 });
        if (remaining.saved_audiences.length || remaining.complete !== true) throw new Error('Deletion not confirmed');
      } catch { throw new AdportError('PROVIDER_ERROR', 'tiktok: deletion readback unconfirmed; reconcile every approved ID before any new delete', { resource_ids: audienceIds }); }
      return audienceIds;
    } };
  }
}

export function tiktokAudienceTools(provider: TikTokAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'tiktok_saved_audiences', namespace: 'tiktok', description: 'List or filter saved targeting templates, up to100 IDs and100 rows/page. Returns snapshot_hash for deletion and explicit native completeness; does not upload customer data or send tracking events.', input: savedAudienceList, presentation: 'records', annotations: { readOnly: true }, handler: input => provider.audiences.list(input) }),
    defineTool({ name: 'tiktok_get_saved_audience', namespace: 'tiktok', description: 'Read one saved targeting template using TikTok’s ID-filtered list endpoint; verifies the selected advertiser and ID and returns its current snapshot_hash.', input: z.object({ account_id: id, saved_audience_id: id }), presentation: 'records', annotations: { readOnly: true }, handler: input => provider.audiences.get(input.account_id, input.saved_audience_id) }),
    guardedWriteTool({ name: 'tiktok_create_saved_audience', namespace: 'tiktok', provider: 'tiktok', kind: 'create', destructive: false, description: 'Create a reusable targeting template with native location, interest, audience, device and action fields. No campaign, budget or delivery update. Requires the existing advertiser permission; independently verifies creation and never retries automatically.', payload: savedAudienceCreate }),
    guardedWriteTool({ name: 'tiktok_delete_saved_audiences', namespace: 'tiktok', provider: 'tiktok', kind: 'remove', destructive: true, description: 'Permanently delete up to100 saved targeting templates using each current snapshot_hash. All IDs must match before any write; filtered readback confirms deletion. No restore endpoint or automatic retry.', payload: savedAudienceDelete }),
  ];
}
