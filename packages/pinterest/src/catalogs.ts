import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type ReviewField, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { PinterestAdsClient } from './client.js';
import { pinterestId } from './schemas.js';
import type { PinterestAdsProvider } from './provider.js';

type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]>; resultDetails?(): unknown; resultWarnings?(): string[] };
const id = z.string().regex(/^\d{1,30}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const type = z.enum(['RETAIL', 'HOTEL', 'CREATIVE_ASSETS']), format = z.enum(['TSV', 'CSV', 'XML', 'INTEGRATION']);
const state = z.enum(['ACTIVE', 'INACTIVE']);
const name = z.string().trim().min(1).max(1024), currency = z.string().regex(/^[A-Z]{3}$/).nullable();
const credentials = z.object({ username: z.string().min(1).max(4096), password: z.string().min(1).max(8192) }).strict().nullable();
const location = z.string().url().max(16384).refine(value => { const url = new URL(value); return ['http:', 'https:', 'ftp:', 'sftp:'].includes(url.protocol) && !url.username && !url.password && !url.hash; }, 'Use an HTTP(S), FTP or SFTP URL without inline credentials or fragments');
const schedule = z.object({ time: z.string().regex(/^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$/), timezone: z.string().min(1).max(100) }).strict().nullable();
const availability = z.enum(['IN_STOCK', 'OUT_OF_STOCK', 'PREORDER']).nullable();
const account = { account_id: pinterestId }, selected = { catalog_id: id }, reference = { ...selected, feed_id: id }, bound = { ...reference, expected_snapshot_hash: hash };
const paging = { page_size: z.number().int().min(1).max(250).default(25), bookmark: z.string().min(1).max(4096).optional() };
const catalog = z.looseObject({ id, name: z.string(), catalog_type: type, created_at: z.string(), updated_at: z.string() });
const feed = z.looseObject({ id, catalog_type: type, catalog_id: id.nullable().optional(), name: z.string().nullable(), status: z.string(), format, default_locale: z.string(), default_country: z.string().optional(), default_currency: z.string().nullable().optional(), default_availability: availability.optional(), preferred_processing_schedule: schedule.optional(), location: z.string(), credentials: z.unknown().optional(), created_at: z.string(), updated_at: z.string() });
const common = { catalog_id: id, name, location, format, default_locale: z.string().min(2).max(40), default_currency: currency.optional(), credentials: credentials.optional(), preferred_processing_schedule: schedule.optional(), status: state.default('INACTIVE') };
const feedCreate = z.discriminatedUnion('catalog_type', [
  z.object({ ...common, catalog_type: z.literal('RETAIL'), default_country: z.string().regex(/^[A-Z]{2}$/), default_availability: availability.optional() }).strict(),
  z.object({ ...common, catalog_type: z.literal('HOTEL') }).strict(),
  z.object({ ...common, catalog_type: z.literal('CREATIVE_ASSETS'), default_country: z.string().regex(/^[A-Z]{2}$/) }).strict(),
]);
const feedChanges = z.object({ name: name.optional(), location: location.optional(), format: format.optional(), default_currency: currency.optional(), default_availability: availability.optional(), credentials: credentials.optional(), preferred_processing_schedule: schedule.optional(), status: state.optional() }).strict().refine(value => Object.keys(value).length > 0, 'Supply at least one feed setting');
const createCatalog = z.object({ expected_context_hash: hash, name, catalog_type: type }).strict();
const createFeed = z.object({ expected_context_hash: hash, feed: feedCreate, confirm_source_access: z.literal(true), confirm_publication: z.boolean().default(false) }).strict();
const updateFeed = z.object({ ...bound, changes: feedChanges, confirm_source_access: z.boolean().default(false), confirm_publication: z.boolean().default(false) }).strict();
const deleteFeed = z.object({ ...bound, confirm_permanent_deletion: z.literal(true) }).strict();
const ingestFeed = z.object({ ...bound, confirm_source_access: z.literal(true), confirm_publication: z.literal(true) }).strict();
const processing = z.looseObject({ id, status: z.enum(['COMPLETED', 'FAILED', 'PROCESSING']), created_at: z.string(), updated_at: z.string(), ingestion_details: z.record(z.string(), z.unknown()), product_counts: z.record(z.string(), z.unknown()), validation_details: z.record(z.string(), z.unknown()) });
const ingestion = z.object({ id, feed_id: id, status: z.enum(['COMPLETED', 'FAILED', 'PROCESSING']), created_at: z.string() });
const writeKinds = { pinterest_create_catalog: 'create', pinterest_create_feed: 'create', pinterest_update_feed: 'update', pinterest_delete_feed: 'remove', pinterest_ingest_feed: 'update' } as const;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : isObject(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
function sourceOrigin(value: string): string { try { const url = new URL(value); return `${url.protocol}//${url.host}`; } catch { return 'Unavailable'; } }
function privateValues(value: z.infer<typeof feed>) { const auth = isObject(value.credentials) ? value.credentials : {}; return [value.location, auth.username, auth.password].filter((v): v is string => typeof v === 'string' && v.length > 0); }
function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  return isObject(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !/credential|password|authorization|access_token|refresh_token|download_url|^location$/i.test(key)).map(([key, item]) => [key, redact(item, secrets)])) : value;
}
function publicFeed(value: z.infer<typeof feed>) {
  const { location, credentials, ...rest } = value;
  const keys = ['id', 'catalog_id', 'catalog_type', 'name', 'status', 'format', 'default_locale', 'default_country', 'default_currency', 'default_availability', 'preferred_processing_schedule', 'created_at', 'updated_at'];
  const selected = Object.fromEntries(keys.filter(key => Object.hasOwn(rest, key)).map(key => [key, rest[key]]));
  const { created_at: _created, updated_at: _updated, ...settings } = selected;
  const config = { ...settings, location, credentials_configured: credentials != null };
  return { ...selected, source_origin: sourceOrigin(location), source_fingerprint: digest(location), credentials_configured: credentials != null, snapshot_hash: digest(config) };
}
const output = z.object({ account_id: pinterestId, context_hash: hash, records: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean() }).passthrough();
const labels: Record<string, string> = { name: 'Name', catalog_type: 'Catalog type', status: 'Feed status', format: 'Format', default_locale: 'Locale', default_country: 'Country', default_currency: 'Currency', default_availability: 'Default availability', preferred_processing_schedule: 'Daily processing schedule' };
function fields(before: Record<string, unknown> | undefined, requested: Record<string, unknown>): ReviewField[] {
  return Object.entries(requested).filter(([key]) => key !== 'catalog_id').map(([key, value]) => key === 'location'
    ? { label: 'Source', ...(before ? { before: { origin: sourceOrigin(String(before.location)), fingerprint: digest(before.location) } } : {}), after: { origin: sourceOrigin(String(value)), fingerprint: digest(value) } }
    : key === 'credentials' ? { label: 'Feed authentication', ...(before ? { before: before.credentials != null ? 'Configured; values hidden' : 'Not configured' } : {}), after: value === null ? 'Remove credentials' : 'Configure credentials; values hidden' }
    : { label: labels[key] ?? key, ...(before && Object.hasOwn(before, key) ? { before: before[key] } : {}), after: value });
}

/** Pinterest-owned OpenAPI 5.28.0, commit 2503147; contracts fetched 2026-11-05. */
export class PinterestCatalogService {
  constructor(private readonly client: PinterestAdsClient) {}
  supports(tool: string) { return Object.hasOwn(writeKinds, tool); }
  private params(account: string, catalog?: string) { return new URLSearchParams({ ad_account_id: pinterestId.parse(account), ...(catalog ? { catalog_id: id.parse(catalog) } : {}) }); }
  private async context(account: string) {
    const value = await this.client.get(`ad_accounts/${pinterestId.parse(account)}`, z.object({ id: pinterestId, owner: z.object({ username: z.string().min(1) }) }));
    if (value.id !== account) throw new AdportError('PROVIDER_ERROR', 'pinterest: catalog advertiser ID mismatch');
    return { account_id: account, context_hash: digest({ account, owner: value.owner.username.toLowerCase() }) };
  }
  private async page<T>(path: string, schema: z.ZodType<T>, params: URLSearchParams, input: { page_size: number; bookmark?: string }) {
    params.set('page_size', String(input.page_size)); if (input.bookmark) params.set('bookmark', input.bookmark);
    const value = await this.client.get(path, z.object({ items: z.array(schema), bookmark: z.string().nullable().optional() }), params);
    const ids = value.items.flatMap(row => isObject(row) && typeof row.id === 'string' ? [row.id] : []);
    if (value.items.length > input.page_size || new Set(ids).size !== ids.length || value.bookmark && (value.bookmark === input.bookmark || !value.items.length)) throw new AdportError('PROVIDER_ERROR', 'pinterest: catalog pagination did not advance consistently');
    return { ...value, truncated: Boolean(value.bookmark), ...(value.bookmark ? { next_cursor: value.bookmark } : {}) };
  }
  private async find<T extends { id?: string }>(path: string, schema: z.ZodType<T>, params: URLSearchParams, wanted: string): Promise<T | undefined> {
    const seen = new Set<string>(), ids = new Set<string>(); let bookmark: string | undefined;
    for (let pages = 0; pages < 40; pages++) {
      const page = await this.page(path, schema, new URLSearchParams(params), { page_size: 250, bookmark });
      for (const row of page.items) { if (row.id && ids.has(row.id)) throw new AdportError('PROVIDER_ERROR', 'pinterest: catalog finder repeated an identity'); if (row.id) ids.add(row.id); if (row.id === wanted) return row; }
      if (!page.next_cursor) return undefined;
      if (seen.has(page.next_cursor)) throw new AdportError('PROVIDER_ERROR', 'pinterest: catalog finder repeated a bookmark');
      seen.add(page.next_cursor); bookmark = page.next_cursor;
    }
    throw new AdportError('PROVIDER_ERROR', 'pinterest: catalog membership lookup exceeded 10,000 rows; membership is unconfirmed');
  }
  private async ownedCatalog(account: string, catalogId: string) {
    const value = await this.find('catalogs', catalog, this.params(account), id.parse(catalogId));
    if (!value) throw new AdportError('INVALID_INPUT', 'pinterest: catalog was not found for the selected advertiser owner');
    return value;
  }
  private validateFeed(value: z.infer<typeof feed>, selected: z.infer<typeof catalog>) {
    if (value.catalog_type !== selected.catalog_type || value.catalog_id != null && value.catalog_id !== selected.id) throw new AdportError('PROVIDER_ERROR', 'pinterest: feed catalog/type mismatch');
    return value;
  }
  private async ownedFeed(account: string, catalogId: string, feedId: string) {
    const selected = await this.ownedCatalog(account, catalogId), member = await this.find('catalogs/feeds', feed, this.params(account, catalogId), id.parse(feedId));
    if (!member) throw new AdportError('INVALID_INPUT', 'pinterest: feed was not found in the selected advertiser catalog');
    this.validateFeed(member, selected);
    const value = await this.client.get(`catalogs/feeds/${feedId}`, feed, this.params(account));
    if (value.id !== feedId) throw new AdportError('PROVIDER_ERROR', 'pinterest: feed ID mismatch');
    return this.validateFeed(value, selected);
  }
  async catalogs(input: { account_id: string; page_size: number; bookmark?: string }) {
    const context = await this.context(input.account_id), page = await this.page('catalogs', catalog, this.params(input.account_id), input);
    return { ...context, ...page, records: page.items.map(value => ({ ...value, snapshot_hash: digest({ id: value.id, name: value.name, catalog_type: value.catalog_type }) })) };
  }
  async getCatalog(account: string, catalogId: string) {
    const context = await this.context(account), value = await this.ownedCatalog(account, catalogId);
    return { ...context, catalog: value, records: [value], truncated: false };
  }
  async feeds(input: { account_id: string; catalog_id: string; page_size: number; bookmark?: string }) {
    const context = await this.context(input.account_id), selected = await this.ownedCatalog(input.account_id, input.catalog_id), page = await this.page('catalogs/feeds', feed, this.params(input.account_id, input.catalog_id), input);
    const items = page.items.map(value => publicFeed(this.validateFeed(value, selected)));
    return { ...context, ...page, items, records: items, catalog_id: selected.id };
  }
  async getFeed(account: string, catalogId: string, feedId: string) {
    const context = await this.context(account), value = publicFeed(await this.ownedFeed(account, catalogId, feedId));
    return { ...context, feed: value, records: [value], truncated: false };
  }
  async results(input: { account_id: string; catalog_id: string; feed_id: string; page_size: number; bookmark?: string }) {
    const context = await this.context(input.account_id), current = await this.ownedFeed(input.account_id, input.catalog_id, input.feed_id);
    const page = await this.safe(current, () => this.page(`catalogs/feeds/${current.id}/processing_results`, processing, this.params(input.account_id), input));
    const items = page.items.map(value => redact(value, privateValues(current)) as Record<string, unknown>);
    return { ...context, ...page, items, records: items, feed_id: current.id };
  }
  async issues(input: { account_id: string; catalog_id: string; feed_id: string; processing_result_id: string; page_size: number; bookmark?: string; item_numbers?: number[]; item_validation_issue?: string }) {
    const context = await this.context(input.account_id), current = await this.ownedFeed(input.account_id, input.catalog_id, input.feed_id);
    const result = await this.safe(current, () => this.find(`catalogs/feeds/${current.id}/processing_results`, processing, this.params(input.account_id), input.processing_result_id));
    if (!result) throw new AdportError('INVALID_INPUT', 'pinterest: processing result was not found for this feed');
    const params = this.params(input.account_id);
    if (input.item_numbers) params.set('item_numbers', input.item_numbers.join(','));
    if (input.item_validation_issue) params.set('item_validation_issue', input.item_validation_issue);
    const page = await this.safe(current, () => this.page(`catalogs/processing_results/${result.id}/item_issues`, z.record(z.string(), z.unknown()), params, input));
    const items = page.items.map(value => redact(value, privateValues(current)) as Record<string, unknown>);
    return { ...context, ...page, items, records: items, feed_id: current.id, processing_result_id: result.id, notes: ['Native issues contain samples of up to 20 affected items per error or warning, not a complete affected-product inventory.'] };
  }
  private async safe<T>(current: z.infer<typeof feed>, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (error) {
      if (!(error instanceof AdportError)) throw new AdportError('PROVIDER_ERROR', 'pinterest: catalog request was not confirmed; reconcile before retrying');
      throw new AdportError(error.code, redact(error.message, privateValues(current)) as string, redact(error.details, privateValues(current)));
    }
  }
  private async verify(resource: string, fn: () => Promise<boolean>) {
    try { if (!await fn()) throw new Error('readback mismatch'); }
    catch { throw new AdportError('PROVIDER_ERROR', 'pinterest: catalog write readback unconfirmed; reconcile the resource ID before a new approval', { resource_ids: [resource] }); }
  }
  async plan(op: WriteOperation): Promise<Plan> {
    if (op.provider !== 'pinterest' || !this.supports(op.tool) || op.kind !== writeKinds[op.tool as keyof typeof writeKinds]) throw new AdportError('INVALID_INPUT', 'pinterest: catalog operation kind mismatch');
    const context = await this.context(op.accountId), base = { coercions: [], budgetDeltas: [], notes: [] };
    const review = (title: string, subject: string, fields: ReviewField[], notices: string[]) => ({ provider: 'pinterest', accountId: op.accountId, kind: op.kind, title, subject, fields, notices });
    if (op.tool === 'pinterest_create_catalog') {
      const input = createCatalog.parse(op.payload);
      if (input.expected_context_hash !== context.context_hash) throw new AdportError('INVALID_INPUT', 'pinterest: catalog advertiser context changed; read catalogs again');
      const body = { name: input.name, catalog_type: input.catalog_type };
      return { ...base, summary: `Create Pinterest ${input.catalog_type} catalog "${input.name}"`, changes: [`+ ${JSON.stringify(body)}`], review: review('Create catalog', input.name, fields(undefined, body), ['Creates an empty catalog. No feed, products, Pins or ads are created. Native catalog-program eligibility is still required.']), execute: async () => {
        const value = await this.client.mutate('catalogs', 'POST', body, catalog, this.params(op.accountId));
        await this.verify(value.id, async () => { const current = await this.ownedCatalog(op.accountId, value.id); return current.name === body.name && current.catalog_type === body.catalog_type; });
        return [value.id];
      } };
    }
    if (op.tool === 'pinterest_create_feed') {
      const input = createFeed.parse(op.payload), body = input.feed, selected = await this.ownedCatalog(op.accountId, body.catalog_id);
      if (input.expected_context_hash !== context.context_hash || selected.catalog_type !== body.catalog_type) throw new AdportError('INVALID_INPUT', 'pinterest: catalog advertiser context/type changed; read catalogs again');
      if (body.status === 'ACTIVE' && !input.confirm_publication) throw new AdportError('INVALID_INPUT', 'pinterest: active feeds may create public product Pins; confirm publication and source access');
      const changes = fields(undefined, body);
      return { ...base, summary: `Create Pinterest feed "${body.name}"`, changes: changes.map(field => `+ ${field.label}: ${JSON.stringify(field.after)}`), review: review('Create feed', body.name, changes, ['Pinterest will store the source URL and any supplied credentials. ACTIVE feeds process automatically and may create product Pins used by ads. No campaign status is changed.']), execute: async () => {
        const value = await this.client.mutate('catalogs/feeds', 'POST', body, feed, this.params(op.accountId));
        await this.verify(value.id, async () => this.matches(await this.ownedFeed(op.accountId, selected.id, value.id), body));
        return [value.id];
      }, resultWarnings: () => ['Saved feed configuration is not proof of source authentication or imported products; read processing results.'] };
    }
    const input = op.tool === 'pinterest_update_feed' ? updateFeed.parse(op.payload) : op.tool === 'pinterest_delete_feed' ? deleteFeed.parse(op.payload) : ingestFeed.parse(op.payload);
    const current = await this.ownedFeed(op.accountId, input.catalog_id, input.feed_id);
    if (publicFeed(current).snapshot_hash !== input.expected_snapshot_hash) throw new AdportError('INVALID_INPUT', 'pinterest: feed configuration changed; read the feed again');
    if (current.status === 'DELETED') throw new AdportError('INVALID_INPUT', 'pinterest: this feed is deleted');
    if (op.tool === 'pinterest_delete_feed') return { ...base, summary: `Delete Pinterest feed ${current.id}`, changes: [`- feed ${current.id}`], review: review('Delete feed', current.name ?? current.id, [{ label: 'Feed', before: current.id, after: null }], ['Permanent removal; no restore endpoint is exposed. Review catalog product and ad dependencies before deletion.']), execute: async () => {
      const result = await this.safe(current, () => this.client.mutate(`catalogs/feeds/${current.id}`, 'DELETE', undefined, z.union([feed, z.undefined()]), this.params(op.accountId)));
      if (result && result.id !== current.id) throw new AdportError('PROVIDER_ERROR', 'pinterest: feed delete receipt ID mismatch', { resource_ids: [current.id] });
      await this.verify(current.id, async () => { const remaining = await this.find('catalogs/feeds', feed, this.params(op.accountId, input.catalog_id), current.id); return !remaining || remaining.status === 'DELETED'; });
      return [current.id];
    } };
    if (op.tool === 'pinterest_ingest_feed') {
      let details: unknown, warning: string[] = [];
      return { ...base, summary: `Process Pinterest feed ${current.id}`, changes: [`~ request processing for feed ${current.id}`], review: review('Process feed', current.name ?? current.id, [{ label: 'Source', after: { origin: sourceOrigin(current.location), fingerprint: digest(current.location) } }], ['Requests native processing of the existing source. This may create/update public product Pins and affect catalog ads. A job receipt is not proof of imported products. Partner access is required.']), execute: async () => {
        const result = await this.safe(current, () => this.client.mutate(`catalogs/feeds/${current.id}/ingest`, 'POST', undefined, ingestion, this.params(op.accountId)));
        if (result.feed_id !== current.id) throw new AdportError('PROVIDER_ERROR', 'pinterest: ingestion receipt feed mismatch', { resource_ids: [current.id, result.id] });
        details = { status: result.status === 'PROCESSING' ? 'ACCEPTED_FOR_PROCESSING' : result.status, processed: result.status === 'COMPLETED', native_status: result.status, ingestion_id: result.id, feed_id: current.id, next_tool: 'pinterest_feed_processing_results' };
        if (result.status === 'FAILED') warning = ['Pinterest reports that the requested ingestion failed. Read processing results; do not automatically retry.'];
        return [result.id];
      }, resultDetails: () => details, resultWarnings: () => warning };
    }
    const update = updateFeed.parse(op.payload), changes = update.changes;
    if (current.catalog_type !== 'RETAIL' && Object.hasOwn(changes, 'default_availability')) throw new AdportError('INVALID_INPUT', 'pinterest: default availability is retail-only');
    if ((changes.location !== undefined || changes.credentials != null || changes.status === 'ACTIVE') && !update.confirm_source_access) throw new AdportError('INVALID_INPUT', 'pinterest: changing feed source/authentication or activating processing requires source-access confirmation');
    if ((changes.status ?? current.status) === 'ACTIVE' && Object.keys(changes).some(key => key !== 'name') && !update.confirm_publication) throw new AdportError('INVALID_INPUT', 'pinterest: changes to an active feed may affect public product Pins; confirm publication');
    if (!Object.entries(changes).some(([key, value]) => key === 'credentials' || !same(current[key], value))) throw new AdportError('INVALID_INPUT', 'pinterest: no supplied feed settings would change');
    const body = { catalog_type: current.catalog_type, ...changes }, visible = fields(current, changes);
    return { ...base, summary: `Update Pinterest feed ${current.id}`, changes: visible.map(field => `~ ${field.label}: ${JSON.stringify(field.before)} → ${JSON.stringify(field.after)}`), review: review('Update feed', current.name ?? current.id, visible, ['Only supplied fields are patched. Existing credential values and source paths are hidden. Credentials are replaced only when explicitly supplied; the snapshot cannot detect password-only changes made elsewhere.']), execute: async () => {
      const result = await this.safe(current, () => this.client.mutate(`catalogs/feeds/${current.id}`, 'PATCH', body, feed, this.params(op.accountId)));
      if (result.id !== current.id) throw new AdportError('PROVIDER_ERROR', 'pinterest: feed update receipt ID mismatch', { resource_ids: [current.id] });
      await this.verify(current.id, async () => this.matches(await this.ownedFeed(op.accountId, input.catalog_id, current.id), changes));
      return [current.id];
    }, resultWarnings: () => changes.location !== undefined || changes.credentials != null ? ['Source downloading/authentication is unverified until native processing results confirm success.'] : [] };
  }
  private matches(current: z.infer<typeof feed>, wanted: Record<string, unknown>) {
    return Object.entries(wanted).every(([key, value]) => {
      if (key === 'catalog_id' && current.catalog_id == null) return true;
      if (key === 'credentials') return value === null ? current.credentials == null : current.credentials != null;
      return same(current[key], value);
    });
  }
}

export function pinterestCatalogTools(provider: PinterestAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'pinterest_catalogs', namespace: 'pinterest', description: 'List selected advertiser-owner catalogs and context_hash with native bookmarks. Requires catalogs:read; no token-owner fallback.', input: z.object({ ...account, ...paging }).strict(), output, presentation: 'records', pagination: { cursorInput: 'bookmark' }, annotations: { readOnly: true }, handler: input => provider.catalogs.catalogs(input) }),
    defineTool({ name: 'pinterest_get_catalog', namespace: 'pinterest', description: 'Find an exact owned catalog via the native scoped finder (bounded 10,000 rows; Pinterest has no catalog GET-by-ID endpoint).', input: z.object({ ...account, ...selected }).strict(), output, presentation: 'records', annotations: { readOnly: true }, handler: input => provider.catalogs.getCatalog(input.account_id, input.catalog_id) }),
    defineTool({ name: 'pinterest_feeds', namespace: 'pinterest', description: 'List one advertiser-owned catalog’s feeds and configuration snapshots. Native bookmarks; source paths/query values and feed credentials stay hidden.', input: z.object({ ...account, ...selected, ...paging }).strict(), output, presentation: 'records', pagination: { cursorInput: 'bookmark' }, annotations: { readOnly: true }, handler: input => provider.catalogs.feeds(input) }),
    defineTool({ name: 'pinterest_get_feed', namespace: 'pinterest', description: 'Verify selected catalog membership and read current feed configuration/snapshot_hash. Authentication values and full source URLs are never returned.', input: z.object({ ...account, ...reference }).strict(), output, presentation: 'records', annotations: { readOnly: true }, handler: input => provider.catalogs.getFeed(input.account_id, input.catalog_id, input.feed_id) }),
    defineTool({ name: 'pinterest_feed_processing_results', namespace: 'pinterest', description: 'Read feed processing status, native product counts and diagnostics with bookmarks. Verifies feed ownership; ingestion acceptance is not product readiness.', input: z.object({ ...account, ...reference, ...paging }).strict(), output, presentation: 'records', pagination: { cursorInput: 'bookmark' }, annotations: { readOnly: true }, handler: input => provider.catalogs.results(input) }),
    defineTool({ name: 'pinterest_feed_item_issues', namespace: 'pinterest', description: 'Read sampled item errors/warnings after verifying processing-result membership in this feed. Up to20 affected items per code; not a complete product inventory.', input: z.object({ ...account, ...reference, processing_result_id: id, ...paging, item_numbers: z.array(z.number().int().nonnegative().safe()).min(1).max(1000).optional(), item_validation_issue: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional() }).strict().refine(value => !value.item_numbers || !value.item_validation_issue, 'Native item-number and validation-issue filters cannot be combined'), output, presentation: 'records', pagination: { cursorInput: 'bookmark' }, annotations: { readOnly: true }, handler: input => provider.catalogs.issues(input) }),
    guardedWriteTool({ name: 'pinterest_create_catalog', namespace: 'pinterest', provider: 'pinterest', kind: 'create', destructive: false, payload: createCatalog, description: 'Create an empty RETAIL, HOTEL or CREATIVE_ASSETS catalog with context_hash from pinterest_catalogs. No feed/products/ads; catalog programs and catalogs:write required.' }),
    guardedWriteTool({ name: 'pinterest_create_feed', namespace: 'pinterest', provider: 'pinterest', kind: 'create', payload: createFeed, sensitiveInputs: ['feed.location', 'feed.credentials'], description: 'Create a feed in an explicitly selected owned catalog. Defaults INACTIVE; supports native formats, schedules and optional private-source credentials. Confirm source access; ACTIVE also requires publication confirmation. Source/auth values are omitted from previews/audits; the agent applies with identical arguments instead of passing secrets to a widget. Requires catalogs read/write.' }),
    guardedWriteTool({ name: 'pinterest_update_feed', namespace: 'pinterest', provider: 'pinterest', kind: 'update', payload: updateFeed, sensitiveInputs: ['changes.location', 'changes.credentials'], description: 'Patch supplied feed settings with a current snapshot_hash, preserving omitted settings. New source/authentication or ACTIVE requires source-access confirmation; active feeds require publication confirmation. Null credentials removes authentication; source/auth changes are applied by the agent without echoing private arguments to a widget.' }),
    guardedWriteTool({ name: 'pinterest_delete_feed', namespace: 'pinterest', provider: 'pinterest', kind: 'remove', payload: deleteFeed, description: 'Permanently delete an owned feed with exact snapshot and explicit deletion confirmation. No restore endpoint is exposed; review product/ad dependencies. Native deletion is reconciled before reporting success.' }),
    guardedWriteTool({ name: 'pinterest_ingest_feed', namespace: 'pinterest', provider: 'pinterest', kind: 'update', payload: ingestFeed, description: 'Request processing for an owned feed with current snapshot and explicit source/publication confirmations. This can create/update product Pins. Partner-only endpoint; returns native job status, never retries and never activates campaigns.' }),
  ];
}
