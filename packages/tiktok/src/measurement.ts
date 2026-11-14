import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { TikTokClient } from './client.js';
import type { TikTokAdsProvider } from './provider.js';
import { nativeListComplete } from './pagination.js';

const id = z.string().regex(/^\d+$/);
const nativeId = z.union([id, z.number().int().positive().safe()]).transform(String);
const matching = z.object({ email: z.boolean(), phone_number: z.boolean() }).strict();
const name = z.string().trim().min(1);
export const pixelList = z.object({
  account_id: id, pixel_id: id.optional(), code: z.string().min(1).optional(), name: name.optional(),
  order_by: z.enum(['EARLIEST_CREATE', 'LATEST_CREATE']).optional(),
  filtering: z.object({ available_for_catalog_only: z.boolean() }).strict().optional(),
  page: z.number().int().positive().safe().default(1), page_size: z.number().int().positive().max(20).default(20),
});
export const pixelCreate = z.object({ pixel_name: name, pixel_category: z.enum(['CONTACTS', 'CUSTOMIZE_EVENTS', 'FILLING_FORM', 'LANDING_PAGE', 'ONLINE_STORE']).optional(), partner_name: z.string().min(1).optional() }).strict();
export const pixelUpdate = z.object({
  pixel_id: id, expected_configuration_hash: z.string().regex(/^[a-f0-9]{64}$/),
  pixel_name: name.optional(), advanced_matching_fields: matching.optional(),
}).strict().refine(value => value.pixel_name !== undefined || value.advanced_matching_fields !== undefined, 'Provide a pixel name or both matching settings');
const date = z.iso.date();
export const pixelStats = z.object({
  account_id: id, pixel_ids: z.array(id).min(1).max(20).refine(values => new Set(values).size === values.length, 'Pixel IDs must be unique; Adport allows 20 per request'),
  date_range: z.object({ start_date: date, end_date: date }).strict().refine(value => value.start_date <= value.end_date, 'End date must not precede start date'),
});
const row = z.looseObject({ pixel_id: nativeId, pixel_name: z.string(), advertiser_id: nativeId.optional() });
const pageInfo = z.looseObject({ page: z.number().int().positive().safe(), page_size: z.number().int().positive().max(20), total_page: z.number().int().nonnegative().safe().optional(), total_number: z.number().int().nonnegative().safe().optional() });
const listResponse = z.looseObject({ pixels: z.array(row), page_info: pageInfo.optional() });
type Pixel = z.infer<typeof row>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const configuration = (value: Pixel) => Object.fromEntries(['pixel_id', 'pixel_name', 'pixel_code', 'pixel_category', 'partner_name', 'advanced_matching_fields'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const hash = (account: string, value: Pixel) => createHash('sha256').update(canonical({ account_id: account, configuration: configuration(value) })).digest('hex');
const notes = ['Local preview only. This manages a Pixel record; it does not install tracking, send events or change ads, budgets or delivery.', 'TikTok permissions remain authoritative. No automatic write retry; reconcile the Pixel ID or list after an uncertain outcome.'];

/** TikTok-owned SDK f809c396: pixel/{list,create,update} and pixel/event/stats. */
export class TikTokMeasurementService {
  constructor(private readonly client: TikTokClient) {}

  async list(raw: z.input<typeof pixelList>) {
    const { account_id, ...input } = pixelList.parse(raw);
    const parsed = listResponse.safeParse(await this.client.get('pixel/list', { advertiser_id: account_id, ...input }));
    if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'tiktok: Pixel response shape could not be verified');
    const data = parsed.data, pixels = data.pixels, page = data.page_info;
    if (pixels.length > input.page_size || new Set(pixels.map(value => value.pixel_id)).size !== pixels.length || pixels.some(value => value.advertiser_id !== undefined && value.advertiser_id !== account_id || input.pixel_id && value.pixel_id !== input.pixel_id)) throw new AdportError('PROVIDER_ERROR', 'tiktok: Pixel response does not match the selected advertiser, ID or page size');
    if (page && (page.page !== input.page || page.page_size !== input.page_size)) throw new AdportError('PROVIDER_ERROR', 'tiktok: Pixel pagination does not match the requested page');
    const complete = nativeListComplete(page, pixels.length);
    return { ...data, pixels: pixels.map((value): Pixel & { configuration_hash: string } => ({ ...value, configuration_hash: hash(account_id, value) })), complete, truncated: complete !== true,
      ...(complete === false ? { next_page: input.page + 1 } : {}),
      ...(complete === null ? { pagination_note: 'Native pagination is missing or contradictory; completeness is unknown.' } : {}),
    };
  }

  async get(account: string, pixelId: string) {
    const data = await this.list({ account_id: account, pixel_id: pixelId });
    const pixel = data.pixels.find(value => value.pixel_id === pixelId);
    if (!pixel && data.complete !== true) throw new AdportError('PROVIDER_ERROR', 'tiktok: Pixel lookup could not confirm absence');
    if (!pixel) throw new AdportError('INVALID_INPUT', 'tiktok: Pixel was not found in the selected advertiser');
    return { pixel };
  }

  async stats(raw: z.input<typeof pixelStats>) {
    const input = pixelStats.parse(raw);
    const parsed = z.looseObject({ list: z.array(z.record(z.string(), z.unknown())) }).safeParse(await this.client.get('pixel/event/stats', { advertiser_id: input.account_id, pixel_ids: input.pixel_ids, date_range: input.date_range }));
    if (!parsed.success || parsed.data.list.some(value => value.advertiser_id !== undefined && String(value.advertiser_id) !== input.account_id || value.pixel_id !== undefined && (!nativeId.safeParse(value.pixel_id).success || !input.pixel_ids.includes(String(value.pixel_id))))) throw new AdportError('PROVIDER_ERROR', 'tiktok: Pixel statistics response does not match the selected advertiser or IDs');
    return { ...parsed.data, pixel_ids: input.pixel_ids, date_range: input.date_range };
  }

  async plan(op: WriteOperation): Promise<Plan> {
    if (op.tool === 'tiktok_create_pixel') {
      const input = pixelCreate.parse(op.payload);
      return { summary: `Create TikTok Pixel "${input.pixel_name}"`, changes: [`+ Pixel ${JSON.stringify(input)}`], notes: [...notes, 'Creation uses TikTok’s native matching defaults; inspect the returned configuration before separately approving matching changes or installing tracking.'], coercions: [], budgetDeltas: [], execute: async () => {
        let result: unknown;
        try { result = await this.client.post('pixel/create', { ...input, advertiser_id: op.accountId }); }
        catch (error) { if (error instanceof AdportError) throw error; throw new AdportError('PROVIDER_ERROR', 'tiktok: Pixel creation outcome unconfirmed; inspect the advertiser list before another create'); }
        const receipt = z.looseObject({ pixel_id: nativeId }).safeParse(result);
        if (!receipt.success) throw new AdportError('PROVIDER_ERROR', 'tiktok: Pixel creation returned no verified ID; inspect the advertiser list before another create');
        const pixelId = receipt.data.pixel_id;
        try {
          const actual = (await this.get(op.accountId, pixelId)).pixel;
          if (!Object.entries(input).every(([key, value]) => actual[key] === value)) throw new Error('Pixel readback differs');
        } catch { throw new AdportError('PROVIDER_ERROR', 'tiktok: Pixel creation readback unconfirmed; reconcile the returned ID before another create', { resource_ids: [pixelId] }); }
        return [pixelId];
      } };
    }
    if (op.tool !== 'tiktok_update_pixel') throw new AdportError('INVALID_INPUT', 'tiktok: unsupported Pixel operation');
    const input = pixelUpdate.parse(op.payload), current = (await this.get(op.accountId, input.pixel_id)).pixel;
    if (current.configuration_hash !== input.expected_configuration_hash) throw new AdportError('INVALID_INPUT', 'tiktok: Pixel configuration changed; read it again before a new preview');
    const previousMatching = matching.safeParse(current.advanced_matching_fields);
    if (!previousMatching.success) throw new AdportError('PROVIDER_ERROR', 'tiktok: current Pixel matching settings could not be verified; no update sent');
    const fields = { pixel_name: input.pixel_name ?? current.pixel_name, advanced_matching_fields: input.advanced_matching_fields ?? previousMatching.data };
    const expected = { ...current, ...fields };
    const updateNotes = [...notes, 'Email and phone matching settings are explicit; a name-only update preserves both current values.'];
    return { summary: `Update TikTok Pixel "${current.pixel_name}"`, changes: [`~ Pixel ${input.pixel_id}: ${JSON.stringify(configuration(current))} → ${JSON.stringify(configuration(expected))}`], notes: updateNotes, coercions: [], budgetDeltas: [],
      review: { provider: 'tiktok', accountId: op.accountId, kind: op.kind, title: 'Update Pixel', subject: current.pixel_name, fields: [
        { label: 'Name', before: current.pixel_name, after: fields.pixel_name },
        { label: 'Email matching', before: previousMatching.data.email, after: fields.advanced_matching_fields.email },
        { label: 'Phone matching', before: previousMatching.data.phone_number, after: fields.advanced_matching_fields.phone_number },
      ], notices: updateNotes }, execute: async () => {
      let accepted = false;
      try {
        await this.client.post('pixel/update', { advertiser_id: op.accountId, pixel_id: input.pixel_id, ...fields });
        accepted = true;
        const actual = (await this.get(op.accountId, input.pixel_id)).pixel;
        if (hash(op.accountId, actual) !== hash(op.accountId, expected)) throw new Error('Pixel update readback differs');
      } catch (error) {
        if (!accepted && error instanceof AdportError && error.message.startsWith('TikTok API error ')) throw error;
        throw new AdportError('PROVIDER_ERROR', 'tiktok: Pixel update outcome unconfirmed; reconcile the returned ID before any further update', { resource_ids: [input.pixel_id] });
      }
      return [input.pixel_id];
    } };
  }
}

export function tiktokMeasurementTools(provider: TikTokAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'tiktok_pixels', namespace: 'tiktok', description: 'Read/filter advertiser Pixels by native ID, code, name, order or catalog availability; max 20/page. Returns configuration_hash and explicit pagination certainty; no tracking events or configuration changes.', input: pixelList, presentation: 'records', annotations: { readOnly: true }, handler: input => provider.measurement.list(input) }),
    defineTool({ name: 'tiktok_get_pixel', namespace: 'tiktok', description: 'Read one advertiser Pixel and its configuration_hash using the ID-filtered native list endpoint. Matching settings are returned for review; tracking is not installed.', input: z.object({ account_id: id, pixel_id: id }), presentation: 'records', annotations: { readOnly: true }, handler: input => provider.measurement.get(input.account_id, input.pixel_id) }),
    defineTool({ name: 'tiktok_pixel_event_stats', namespace: 'tiktok', description: 'Read native event statistics for explicit Pixel IDs and a date range. Adport limit 20 IDs/request. Returns provider-native fields; does not send test or live conversion events.', input: pixelStats, presentation: 'records', annotations: { readOnly: true }, handler: input => provider.measurement.stats(input) }),
    guardedWriteTool({ name: 'tiktok_create_pixel', namespace: 'tiktok', provider: 'tiktok', kind: 'create', destructive: false, description: 'Create a native advertiser Pixel record and independently verify the returned ID and fields. Does not install tracking, send events or change ads. TikTok controls creation defaults; no automatic retry.', payload: pixelCreate }),
    guardedWriteTool({ name: 'tiktok_update_pixel', namespace: 'tiktok', provider: 'tiktok', kind: 'update', destructive: false, description: 'Update Pixel name or explicit email/phone matching flags using its current configuration_hash. Verifies current settings before writing and independently reads back the result. Omitted flags are preserved; no tracking install or event sending.', payload: pixelUpdate }),
  ];
}
