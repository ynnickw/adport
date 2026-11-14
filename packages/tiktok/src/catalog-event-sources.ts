import { createHash } from 'node:crypto';
import { AdportError, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { TikTokClient } from './client.js';
import { catalogId, catalogInput } from './catalog-schema.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/), nativeId = z.union([catalogId, z.number().int().positive().safe()]).transform(String);
const code = z.string().min(1).max(256).regex(/^[^\u0000-\u0020\u007f]+$/), text = z.string().max(4000);
const selectedFields = { app_id: catalogId.optional(), pixel_code: code.optional() };
const hasSource = (value: { app_id?: string | null; pixel_code?: string | null }) => !!(value.app_id || value.pixel_code);
const paging = { cursor: z.string().min(1).max(512).optional(), page_size: z.number().int().min(1).max(100).default(30) };
export const catalogEventList = catalogInput.extend(paging).strict();
export const catalogEventApps = catalogInput.extend({ ...paging, app_platform_ids: z.array(z.string().min(1).max(1000)).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Platform IDs must be unique').optional() }).strict();
export const catalogEventContext = catalogInput.extend({ ...selectedFields, purpose: z.enum(['bind', 'unbind']).default('bind') }).strict().refine(hasSource, 'Select an app_id, pixel_code or both');
export const catalogEventChange = catalogInput.omit({ account_id: true }).extend({ ...selectedFields, expected_catalog_hash: hash, expected_bindings_hash: hash, expected_sources_hash: hash, acknowledge_shared_effects: z.literal(true), acknowledge_measurement_effects: z.literal(true) }).strict().refine(hasSource, 'Select an app_id, pixel_code or both; an empty selector cannot unbind all sources');
type Scope = z.infer<typeof catalogInput>;
type Selector = { app_id?: string; pixel_code?: string };
type Parent = { configuration_hash: string; can_write: boolean };
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
type Member = { type: 'APP' | 'PIXEL'; id: string; name: string };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const key = (value: Pick<Member, 'type' | 'id'>) => value.type + ':' + value.id;
const identities = (rows: Member[]) => rows.map(({ type, id }) => ({ type, id })).sort((a, b) => key(a).localeCompare(key(b)));
const invalid = () => new AdportError('PROVIDER_ERROR', 'TikTok catalog event-source scope, identifiers or response shape could not be verified.');
const failure = (error: unknown, message: string, ids?: string[]) => {
  const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  return new AdportError('PROVIDER_ERROR', message + ' Provider bodies stay hidden; no request was retried.', { ...(Number.isSafeInteger(details.code) ? { provider_code: details.code } : {}), ...(typeof details.request_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(details.request_id) ? { request_id: details.request_id } : {}), ...(ids ? { resourceIds: ids } : {}) });
};
const nativeApp = z.object({ advertiser_id: nativeId, app_id: nativeId, app_name: text, app_platform_id: z.string().min(1).max(1000), platform: z.enum(['ANDROID', 'IOS']).optional(), package_name: text.optional(), self_attribution_enabled: z.boolean().optional(), skan_allowed: z.enum(['ALLOWED', 'NOT_ALLOWED']).optional(), advanced_dedicated_campaign_allowed: z.boolean().optional(), is_attribution_flex_enable: z.boolean().optional() });
const matching = z.object({ email: z.boolean().optional(), phone_number: z.boolean().optional(), name: z.boolean().optional(), address: z.boolean().optional(), external_id: z.boolean().optional() });
const nativePixel = z.object({ pixel_id: nativeId, pixel_code: code, pixel_name: text, advertiser_id: nativeId.optional(), asset_ownership: z.object({ asset_relation_status: z.string().nullable().optional(), ownership_status: z.boolean().optional(), owner_bc_id: nativeId.nullable().optional() }).optional(), advanced_matching_fields: matching.optional(), automatic_advanced_matching_fields: matching.optional(), enable_first_party_cookies: z.boolean().optional(), enable_expanded_data_sharing: z.boolean().optional() });
function page<T>(scope: unknown, rows: T[], cursor: string | undefined, size: number) {
  const snapshot = digest({ scope, rows });let index = 0;
  if (cursor) {
    try { const parsed = z.object({ h: hash, i: z.number().int().positive().safe() }).strict().parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));if (parsed.h !== snapshot || parsed.i >= rows.length) throw new Error();index = parsed.i; }
    catch { throw new AdportError('INVALID_INPUT', 'The source inventory, selection or cursor changed. Read the first page again.'); }
  }
  const selected = rows.slice(index, index + size), next = index + selected.length;
  return { selected, complete: next === rows.length, truncated: next < rows.length, ...(next < rows.length ? { next_cursor: Buffer.from(JSON.stringify({ h: snapshot, i: next })).toString('base64url') } : {}) };
}

/** Native catalog event-source bindings, not event ingestion. Official contracts refreshed 2026-11-05. */
export class TikTokCatalogEventSources {
  constructor(private readonly client: Pick<TikTokClient, 'get' | 'post'>, private readonly parent: (scope: Scope, write?: boolean) => Promise<Parent>) {}
  private async get(path: string, params: Record<string, unknown>) {
    try { return await this.client.get(path, params, { jsonContentType: true }); } catch (error) { throw failure(error, 'Catalog event-source read failed. Check native source/catalog access.'); }
  }
  private async bindings(scope: Scope) {
    const response = z.object({ catalog_id: nativeId, bc_id: nativeId.optional(), event_sources: z.array(z.object({ event_source_name: text.nullable().optional(), app_id: nativeId.nullable().optional(), pixel_code: code.nullable().optional() }).refine(hasSource)).max(5000) }).safeParse(await this.get('catalog/eventsource_bind/get', { bc_id: scope.bc_id, catalog_id: scope.catalog_id }));
    if (!response.success || response.data.catalog_id !== scope.catalog_id || response.data.bc_id !== undefined && response.data.bc_id !== scope.bc_id) throw invalid();
    const rows: Member[] = response.data.event_sources.flatMap(row => [...(row.app_id ? [{ type: 'APP' as const, id: row.app_id, name: row.event_source_name ?? 'App event source' }] : []), ...(row.pixel_code ? [{ type: 'PIXEL' as const, id: row.pixel_code, name: row.event_source_name ?? 'Web Pixel' }] : [])]);
    if (rows.length > 5000 || new Set(rows.map(key)).size !== rows.length) throw invalid();
    rows.sort((a, b) => key(a).localeCompare(key(b)));return { rows, hash: digest({ ...scope, bindings: identities(rows) }) };
  }
  async list(value: unknown) {
    const input = catalogEventList.parse(value), scope = catalogInput.parse({ account_id: input.account_id, bc_id: input.bc_id, catalog_id: input.catalog_id }), parent = await this.parent(scope), native = await this.bindings(scope), result = page({ ...scope, kind: 'bindings' }, native.rows, input.cursor, input.page_size);
    return { event_sources: result.selected, records: result.selected.map(row => ({ id: key(row), name: row.name, type: row.type, source_id: row.id })), configuration_hash: native.hash, expected_catalog_hash: parent.configuration_hash, total_in_response: native.rows.length, complete: result.complete, truncated: result.truncated, ...('next_cursor' in result ? { next_cursor: result.next_cursor } : {}), notes: ['Catalog-level bindings may be shared across advertisers. This list does not establish that every source belongs to the selected advertiser.', 'Native endpoint is unpaged; Adport snapshot-pages a bounded response locally. Source IDs/hashes are configuration, not event history or event-ingestion credentials.'] };
  }
  async apps(value: unknown) {
    const input = catalogEventApps.parse(value), scope = catalogInput.parse({ account_id: input.account_id, bc_id: input.bc_id, catalog_id: input.catalog_id });await this.parent(scope);
    const response = z.object({ apps: z.array(nativeApp).max(5000) }).safeParse(await this.get('app/list', { advertiser_id: scope.account_id, ...(input.app_platform_ids ? { app_platform_ids: input.app_platform_ids } : {}) }));
    if (!response.success || response.data.apps.some(row => row.advertiser_id !== scope.account_id || input.app_platform_ids && !input.app_platform_ids.includes(row.app_platform_id)) || new Set(response.data.apps.map(row => row.app_id)).size !== response.data.apps.length) throw invalid();
    const rows = response.data.apps.sort((a, b) => a.app_id.localeCompare(b.app_id)), result = page({ ...scope, kind: 'apps', app_platform_ids: input.app_platform_ids ?? null }, rows, input.cursor, input.page_size);
    return { apps: result.selected, records: result.selected.map(row => ({ id: row.app_id, name: row.app_name, platform: row.platform ?? 'Not reported', app_platform_id: row.app_platform_id, skan_allowed: row.skan_allowed ?? 'Not reported' })), total_in_response: rows.length, complete: result.complete, truncated: result.truncated, ...('next_cursor' in result ? { next_cursor: result.next_cursor } : {}), notes: ['Advertiser app discovery, not a guarantee of catalog binding eligibility. Use the native app_id for event-source binding; app_platform_id and tiktok_app_id are different identifiers.', 'Native endpoint is unpaged; Adport snapshot-pages at most 5,000 apps, up to 100 per local page. Tracking URLs, partner tokens, raw icons and other private fields are omitted.'] };
  }
  private async selected(scope: Scope, input: Selector, purpose: 'bind' | 'unbind') {
    const sources: Array<Record<string, unknown> & Member> = [];
    if (input.app_id) {
      const response = z.object({ app: nativeApp }).safeParse(await this.get('app/info', { advertiser_id: scope.account_id, app_id: input.app_id }));
      if (!response.success || response.data.app.advertiser_id !== scope.account_id || response.data.app.app_id !== input.app_id) throw invalid();
      const app = response.data.app;sources.push({ type: 'APP', id: app.app_id, name: app.app_name, ...app });
    }
    if (input.pixel_code) {
      const response = z.object({ pixels: z.array(nativePixel).max(20), page_info: z.object({ page: z.literal(1), page_size: z.literal(20), total_page: z.number().int().nonnegative().safe().optional(), total_number: z.number().int().nonnegative().safe().optional() }).optional() }).safeParse(await this.get('pixel/list', { advertiser_id: scope.account_id, code: input.pixel_code, page: 1, page_size: 20, ...(purpose === 'bind' ? { filtering: { available_for_catalog_only: true } } : {}) }));
      if (!response.success || response.data.pixels.length !== 1 || (response.data.page_info?.total_page ?? 1) !== 1 || response.data.page_info?.total_number !== undefined && response.data.page_info.total_number !== 1) throw invalid();
      const pixel = response.data.pixels[0]!;if (pixel.pixel_code !== input.pixel_code || pixel.advertiser_id !== undefined && pixel.advertiser_id !== scope.account_id || pixel.asset_ownership?.asset_relation_status === 'UNBOUND') throw invalid();
      sources.push({ type: 'PIXEL', id: pixel.pixel_code, name: pixel.pixel_name, ...pixel });
    }
    return { sources, hash: digest({ ...scope, purpose, sources }) };
  }
  private async contextFor(scope: Scope, input: Selector, purpose: 'bind' | 'unbind', write = false) {
    const parent = await this.parent(scope, write), bindings = await this.bindings(scope), selected = await this.selected(scope, input, purpose);
    const keys = new Set(bindings.rows.map(key));if (selected.sources.some(row => purpose === 'bind' ? keys.has(key(row)) : !keys.has(key(row)))) throw new AdportError('INVALID_INPUT', purpose === 'bind' ? 'A selected source is already bound. Select only new bindings, or split the change.' : 'Every selected source must already be bound. No unbind-all operation is inferred.');
    return { parent, bindings, selected };
  }
  async context(value: unknown) {
    const input = catalogEventContext.parse(value), scope = catalogInput.parse({ account_id: input.account_id, bc_id: input.bc_id, catalog_id: input.catalog_id }), current = await this.contextFor(scope, input, input.purpose);
    return { expected_catalog_hash: current.parent.configuration_hash, expected_bindings_hash: current.bindings.hash, expected_sources_hash: current.selected.hash, purpose: input.purpose, selected_sources: current.selected.sources, records: current.selected.sources.map(row => ({ id: key(row), name: row.name, type: row.type, source_id: row.id, change: input.purpose === 'bind' ? 'Bind to catalog' : 'Unbind from catalog' })), binding_count: current.bindings.rows.length, complete: true, truncated: false, notes: ['Selected sources were verified through the selected advertiser’s native app/Pixel endpoints. The catalog is a separately granted shared Business Center asset.', 'Binding changes can affect product/event matching, retargeting, measurement and existing catalog ads. No tracking is installed and no events are sent.', 'Snapshots are rechecked at apply; there is no native atomic cross-resource guarantee. Unselected binding identities must survive readback.'] };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const bind = op.tool === 'tiktok_bind_catalog_event_sources';if (op.provider !== 'tiktok' || !(bind && op.kind === 'update' || op.tool === 'tiktok_unbind_catalog_event_sources' && op.kind === 'remove')) throw new AdportError('INVALID_INPUT', 'Unsupported catalog event-source operation or kind.');
    const input = catalogEventChange.parse(op.payload), scope = catalogInput.parse({ account_id: op.accountId, bc_id: input.bc_id, catalog_id: input.catalog_id }), purpose = bind ? 'bind' : 'unbind';
    const prepare = async () => { const current = await this.contextFor(scope, input, purpose, true);if (current.parent.configuration_hash !== input.expected_catalog_hash || current.bindings.hash !== input.expected_bindings_hash || current.selected.hash !== input.expected_sources_hash) throw new AdportError('PENDING_MISMATCH', 'Catalog, bindings or selected sources changed. Read context and request a new preview.');return current; };
    const current = await prepare(), selected = current.selected.sources, title = bind ? 'Bind catalog event sources' : 'Unbind catalog event sources';
    const notes = ['Local preview only. Changes shared catalog product/event matching and may affect measurement, retargeting and existing ads.', 'No tracking installation, event ingestion, budget or ad-status change. Source access and native catalog eligibility remain authoritative.', 'All unselected binding identities are checked after the write. There is no atomic cross-resource guarantee; uncertain or partial results are never replayed.'];
    return { summary: title + ' · catalog ' + input.catalog_id, changes: selected.map(row => `${bind ? '+' : '-'} ${row.type} ${row.name} (${row.id})`), coercions: [], budgetDeltas: [], notes,
      review: { provider: 'tiktok', accountId: scope.account_id, kind: bind ? 'update' : 'remove', title, subject: input.catalog_id, fields: [{ label: 'Catalog', after: input.catalog_id }, ...selected.map(row => ({ label: row.type === 'APP' ? 'App event source' : 'Web Pixel', before: bind ? 'Not bound' : row.name + ' (' + row.id + ')', after: bind ? row.name + ' (' + row.id + ')' : 'Unbound' })), { label: 'Other bindings preserved', after: String(current.bindings.rows.length - (bind ? 0 : selected.length)) }], notices: notes },
      execute: async () => {
        const fresh = await prepare(), selectedKeys = new Set(selected.map(key)), expected = bind ? [...fresh.bindings.rows, ...selected] : fresh.bindings.rows.filter(row => !selectedKeys.has(key(row)));
        try {
          const receipt = await this.client.post<unknown>('catalog/eventsource/' + purpose, { advertiser_id: scope.account_id, bc_id: input.bc_id, catalog_id: input.catalog_id, ...(input.app_id ? { app_id: input.app_id } : {}), ...(input.pixel_code ? { pixel_code: input.pixel_code } : {}) });
          if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Unexpected acknowledgement');await this.parent(scope, true);const actual = await this.bindings(scope);
          if (canonical(identities(actual.rows)) !== canonical(identities(expected))) throw new Error('Binding readback differs');return [scope.catalog_id, ...selected.map(row => row.id)];
        } catch (error) { throw failure(error, 'Catalog binding change or preservation readback is unconfirmed. Inspect known catalog/source IDs before another change.', [scope.catalog_id, ...selected.map(row => row.id)]); }
      } };
  }
}
