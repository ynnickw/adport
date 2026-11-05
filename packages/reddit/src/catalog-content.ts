import { createHash } from 'node:crypto';
import { AdportError, type Creative, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { RedditAdsClient, RedditEnvelope } from './client.js';
import type { RedditCatalogService } from './catalogs.js';
import { redditCatalogId } from './catalog-access.js';
import { catalogInput } from './catalog-schemas.js';
import { productId, productList, setProductList, setInput, setList, setCreate, setUpdate, setDelete, importInput, importList, importIssues, validFilter } from './catalog-content-schemas.js';

type Scope = z.infer<typeof catalogInput>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
type Client = Pick<RedditAdsClient, 'get' | 'post' | 'patch' | 'delete' | 'nextUrl' | 'diagnostic'>;
const scope = (input: Scope): Scope => ({ account_id: input.account_id, business_id: input.business_id, catalog_id: input.catalog_id });
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const filterValue = (value: string) => { try { return JSON.parse(value) as unknown; } catch { return value; } };
function filterText(value: string) {
  if (!validFilter(value)) return value;
  const labels: Record<string, string> = { contains: 'contains', not_contains: 'does not contain', i_contains: 'contains (case insensitive)', i_not_contains: 'does not contain (case insensitive)', starts_with: 'starts with', i_starts_with: 'starts with (case insensitive)', is_any: 'matches any of', is_not_any: 'matches none of', i_is_any: 'matches any of (case insensitive)', i_is_not_any: 'matches none of (case insensitive)', eq: 'equals', neq: 'does not equal', lt: 'is less than', lte: 'is at most', gt: 'is greater than', gte: 'is at least' };
  const text = (item: Record<string, unknown>): string => { const [key, condition] = Object.entries(item)[0]!;if (key === 'and' || key === 'or') return (key === 'and' ? 'All conditions' : 'Any condition') + ': (' + (condition as Record<string, unknown>[]).map(text).join('; ') + ')';const [operator, operand] = Object.entries(condition as Record<string, unknown>)[0]!;return key.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase()) + ' ' + labels[operator] + ' ' + (Array.isArray(operand) ? operand.join(', ') : String(operand)); };
  return text(JSON.parse(value));
}
const count = z.number().int().nonnegative().safe();
const setRow = z.object({ id: redditCatalogId, catalog_id: redditCatalogId, name: z.string().min(1).max(100), filter: z.string().max(65_536), summary: z.object({ products_count: count.optional(), approved_products_count: count.nullable().optional(), rejected_products_count: count.nullable().optional(), invalid_products_count: count.nullable().optional() }).optional() });
type ProductSet = z.infer<typeof setRow>;
const setConfig = (row: ProductSet) => ({ id: row.id, catalog_id: row.catalog_id, name: row.name, filter: filterValue(row.filter) });
const setHash = (input: Scope, row: ProductSet) => digest({ ...scope(input), configuration: setConfig(row) });
const issueRow = z.object({ field: z.string().max(1000).nullable().optional(), severity: z.enum(['WARNING', 'CRITICAL']), code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), message: z.string().max(40_000).optional() });
const productRow = z.object({ id: productId, price: z.string().max(256).optional(), link: z.string().max(8192).optional(), image_link: z.string().max(8192).optional(), item_group_id: z.string().max(1000).nullable().optional(), brand: z.string().max(4000).nullable().optional(), availability: z.enum(['BACKORDER', 'IN_STOCK', 'OUT_OF_STOCK', 'PREORDER']).nullable().optional(), reddit: z.object({ id: redditCatalogId.optional(), catalog_id: redditCatalogId, image_link: z.string().max(8192).nullable().optional(), approval_decision: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(), issues: z.array(issueRow).max(1000).nullable().optional() }) });
const importRow = z.object({ id: redditCatalogId, catalog_id: redditCatalogId, feed_id: redditCatalogId.optional(), filename: z.string().max(4000).optional(), status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED']), summary: z.object({ added_products_count: count.nullable().optional(), modified_products_count: count.nullable().optional(), deleted_products_count: count.nullable().optional(), invalid_products_count: count.nullable().optional() }).nullable().optional() });
const nativePage = z.object({ next_url: z.string().url().max(8192).nullable().optional() });
function failure(error: unknown, message: string, ids?: string[]) {
  const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  return new AdportError('PROVIDER_ERROR', message + ' No native mutation was retried; provider bodies stay hidden.', { ...(Number.isInteger(details.http_status) ? { http_status: details.http_status } : {}), ...(ids ? { resourceIds: ids } : {}) });
}
const invalid = () => new AdportError('PROVIDER_ERROR', 'Reddit catalog child scope or response shape could not be verified.');
function safeUrl(value: string | null | undefined, image = false) {
  try { const url = new URL(value!);if (!(image ? url.protocol === 'https:' && /\.(redd\.it|redditmedia\.com|redditstatic\.com)$/.test(url.hostname) : ['https:', 'http:'].includes(url.protocol)) || url.username || url.password) return;return url.href; } catch { return; }
}

/** Catalog grants cover children only after independent native parent/catalog verification. */
export class RedditCatalogContentService {
  constructor(private readonly client: Client, private readonly catalogs: RedditCatalogService) {}
  private async request(path: string, absent = false): Promise<RedditEnvelope<unknown> | undefined> {
    try { return await this.client.get<unknown>(path); } catch (error) {
      if (absent && error instanceof AdportError && (error.details as Record<string, unknown> | undefined)?.http_status === 404) return;
      throw failure(error, 'Reddit catalog content read failed.');
    }
  }
  private url(path: string, params: Record<string, string | number | string[] | undefined> = {}) {
    const url = new URL('https://ads-api.reddit.com/api/v3/' + path);
    for (const [key, value] of Object.entries(params)) if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, item));else if (value !== undefined) url.searchParams.set(key, String(value));
    return url.href;
  }
  private async page<T>(path: string, params: Record<string, string | number | string[] | undefined>, schema: z.ZodType<T>, cursor?: string) {
    const first = this.url(path, params), current = cursor ? this.client.nextUrl(cursor, first) : first, response = (await this.request(current))!, parsed = z.array(schema).max(1000).safeParse(response.data), pagination = nativePage.safeParse(response.pagination);
    if (!parsed.success || !pagination.success || parsed.data.length > Number(params['page.size'])) throw invalid();
    const next = pagination.data.next_url ? this.client.nextUrl(pagination.data.next_url, first) : undefined;if (next === current) throw new AdportError('PROVIDER_ERROR', 'Reddit catalog pagination did not advance.');
    return { rows: parsed.data, next_cursor: next, truncated: !!next, complete: !next };
  }
  private async set(input: z.infer<typeof setInput>, absent = false) {
    const response = await this.request('product_sets/' + encodeURIComponent(input.product_set_id), absent);if (!response && absent) return;
    const parsed = setRow.safeParse(response?.data);if (!parsed.success || parsed.data.id !== input.product_set_id || parsed.data.catalog_id !== input.catalog_id) throw invalid();return parsed.data;
  }
  async sets(value: unknown) {
    const input = setList.parse(value);await this.catalogs.authorize(scope(input));const result = await this.page('product_catalogs/' + encodeURIComponent(input.catalog_id) + '/product_sets', { 'page.size': input.page_size }, setRow, input.cursor);
    if (result.rows.some(row => row.catalog_id !== input.catalog_id) || new Set(result.rows.map(row => row.id)).size !== result.rows.length) throw invalid();
    return { product_sets: result.rows.map(row => ({ ...row, configuration_hash: setHash(input, row) })), records: result.rows.map(row => ({ id: row.id, name: row.name, filter: filterText(row.filter), products: row.summary?.products_count })), next_cursor: result.next_cursor, truncated: result.truncated, complete: result.complete };
  }
  async getSet(value: unknown) {
    const input = setInput.parse(value);await this.catalogs.authorize(scope(input));const row = (await this.set(input))!;
    return { product_set: { ...row, configuration_hash: setHash(input, row) }, records: [{ id: row.id, name: row.name, filter: filterText(row.filter), products: row.summary?.products_count }], complete: true, truncated: false, notes: ['The hash binds the exact account/Business/catalog/set configuration, excluding volatile product counts. Project access is checked separately. Set membership can change independently.'] };
  }
  async products(value: unknown, inSet = false) {
    const selectedSet = inSet ? setProductList.parse(value) : undefined, input = selectedSet ?? productList.parse(value);await this.catalogs.authorize(scope(input));
    if (selectedSet) await this.set(selectedSet);
    const path = selectedSet ? 'product_sets/' + encodeURIComponent(selectedSet.product_set_id) + '/products' : 'product_catalogs/' + encodeURIComponent(input.catalog_id) + '/products', result = await this.page(path, { 'page.size': input.page_size, ids: input.ids, approval_decision: input.approval_decision, search: input.search, issue_code: selectedSet?.issue_code }, productRow, input.cursor);
    if (result.rows.some(row => row.reddit.catalog_id !== input.catalog_id || input.ids && !input.ids.includes(row.id)) || new Set(result.rows.map(row => row.id)).size !== result.rows.length) throw invalid();
    const products = result.rows.map(row => ({ ...row, link: safeUrl(row.link), image_link: safeUrl(row.image_link), reddit: { ...row.reddit, image_link: safeUrl(row.reddit.image_link), issues: row.reddit.issues?.map(issue => ({ ...issue, message: this.client.diagnostic(issue.message) })) } }));
    const creatives: Creative[] = products.map(row => { const image = safeUrl(row.reddit.image_link, true), landing = safeUrl(row.link);return { id: row.id, provider: 'reddit', account_id: input.account_id, name: row.id, type: 'CATALOG_PRODUCT', status: row.reddit.approval_decision, headlines: [], descriptions: [row.price, row.brand, row.availability].filter((v): v is string => typeof v === 'string'), landing_urls: landing ? [landing] : [], media: image ? [{ type: 'image', url: image, alt: row.id }] : [], actions: [] }; });
    return { products, creatives, next_cursor: result.next_cursor, truncated: result.truncated, complete: result.complete, notes: ['Native product IDs and supplied filters are preserved. Missing titles/descriptions or approval/count fields remain unavailable. Only Reddit-hosted native preview images are embedded; merchant hosts are not added to widget CSP.'] };
  }
  async imports(value: unknown) {
    const input = importList.parse(value);await this.catalogs.authorize(scope(input));const result = await this.page('product_catalogs/' + encodeURIComponent(input.catalog_id) + '/catalog_imports', { 'page.size': input.page_size, feed_ids: input.feed_ids, statuses: input.statuses?.join(',') }, importRow, input.cursor);
    if (result.rows.some(row => row.catalog_id !== input.catalog_id || input.feed_ids && (!row.feed_id || !input.feed_ids.includes(row.feed_id)) || input.statuses && !input.statuses.includes(row.status)) || new Set(result.rows.map(row => row.id)).size !== result.rows.length) throw invalid();
    return { imports: result.rows, records: result.rows.map(row => ({ id: row.id, name: row.filename ?? 'Catalog import', status: row.status, feed_id: row.feed_id, ...row.summary })), next_cursor: result.next_cursor, truncated: result.truncated, complete: result.complete };
  }
  private async selectedImport(input: z.infer<typeof importInput>) {
    await this.catalogs.authorize(scope(input));let cursor: string | undefined;const seen = new Set<string>(), ids = new Set<string>();
    for (let pages = 0; pages < 10; pages++) {
      const result = await this.page('product_catalogs/' + encodeURIComponent(input.catalog_id) + '/catalog_imports', { 'page.size': 1000 }, importRow, cursor);
      if (result.rows.some(row => row.catalog_id !== input.catalog_id || ids.has(row.id)) || new Set(result.rows.map(row => row.id)).size !== result.rows.length) throw invalid();result.rows.forEach(row => ids.add(row.id));
      const selected = result.rows.find(row => row.id === input.import_id);if (selected) return selected;
      if (!result.next_cursor) throw new AdportError('INVALID_INPUT', 'The import is not in this catalog.');
      if (seen.has(result.next_cursor)) throw invalid();seen.add(result.next_cursor);cursor = result.next_cursor;
    }
    throw new AdportError('PROVIDER_ERROR', 'Selected import membership was not established within the 10,000-row verification bound. Narrow catalog access or inspect native import history.');
  }
  async issues(value: unknown) {
    const input = importIssues.parse(value);await this.selectedImport(input);const schema = issueRow.extend({ id: redditCatalogId, import_id: redditCatalogId, line: count.nullable().optional(), product_id: productId.nullable().optional() }), result = await this.page('catalog_imports/' + encodeURIComponent(input.import_id) + '/issues', { 'page.size': input.page_size, code: input.code }, schema, input.cursor);
    if (result.rows.some(row => row.import_id !== input.import_id || input.code && row.code !== input.code) || new Set(result.rows.map(row => row.id)).size !== result.rows.length) throw invalid();
    const issues = result.rows.map(row => ({ ...row, message: this.client.diagnostic(row.message) }));return { issues, records: issues.map(row => ({ ...row, name: row.code })), next_cursor: result.next_cursor, truncated: result.truncated, complete: result.complete };
  }
  async report(value: unknown) {
    const input = importInput.parse(value);await this.selectedImport(input);const result = (await this.request('catalog_imports/' + encodeURIComponent(input.import_id) + '/report'))!, raw = result.data;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) return { report_available: false, records: [{ id: input.import_id, name: 'Import report unavailable' }], notes: ['The native response supplied no report. This is not evidence that the import has no issues.'] };
    const parsed = z.object({ url: z.string().url().max(8192), expires_at: z.iso.datetime({ offset: true }) }).safeParse(raw);if (!parsed.success || !safeUrl(parsed.data.url) || new URL(parsed.data.url).protocol !== 'https:' || Date.parse(parsed.data.expires_at) <= Date.now()) throw invalid();
    return { report_available: true, import_id: input.import_id, download_url: parsed.data.url, expires_at: parsed.data.expires_at, records: [{ id: input.import_id, name: 'Catalog import report', expires_at: parsed.data.expires_at }], notes: ['Temporary native download URL for this verified catalog/import only. Adport does not fetch it or forward Reddit credentials to its host.'] };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const create = op.tool === 'reddit_create_catalog_product_set', update = op.tool === 'reddit_update_catalog_product_set', remove = op.tool === 'reddit_delete_catalog_product_set';
    if (op.provider !== 'reddit' || !(create && op.kind === 'create' || update && op.kind === 'update' || remove && op.kind === 'remove')) throw new AdportError('INVALID_INPUT', 'Unsupported catalog product-set operation/kind.');
    const input = create ? setCreate.parse(op.payload) : update ? setUpdate.parse(op.payload) : setDelete.parse(op.payload), selected: Scope = { account_id: op.accountId, business_id: input.business_id, catalog_id: input.catalog_id };
    const prepare = async () => {
      const parent = await this.catalogs.authorize(selected, true);
      if ('expected_catalog_configuration_hash' in input) { if (parent.configuration_hash !== input.expected_catalog_configuration_hash) throw new AdportError('PENDING_MISMATCH', 'Catalog configuration changed; read it and preview again.');return; }
      const current = (await this.set({ ...selected, product_set_id: input.product_set_id }))!;if (setHash(selected, current) !== input.expected_configuration_hash || 'confirm_name' in input && current.name !== input.confirm_name) throw new AdportError('PENDING_MISMATCH', 'Product-set configuration/name changed; read and preview again.');return current;
    };
    const current = await prepare(), data = { ...('name' in input && input.name !== undefined ? { name: input.name } : {}), ...('filter' in input && input.filter !== undefined ? { filter: input.filter } : {}) }, title = create ? 'Create product set' : update ? 'Update product set' : 'Delete product set permanently', notes = ['This is a shared Business catalog; set membership and ads using it may be affected. No ads, spend or conversion events are submitted.', ...(remove ? ['Deletes the set definition, not a snapshot of products. Dependent ads and current matching membership are not enumerated or frozen. No native restore/global usage guarantee.'] : ['Filter JSON is sent once as the native string. Omitted set configuration is preserved and independently checked after updates.']), 'Native results are never replayed automatically. Reconcile known IDs after uncertain mutation or readback.'];
    return { summary: `${title} · ${'name' in input && input.name !== undefined ? input.name : current!.name}`, changes: [remove ? '- Product set ' + current!.id : (create ? '+ ' : '~ ') + 'Product set ' + canonical(data)], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'reddit', accountId: op.accountId, kind: op.kind, title, subject: 'name' in input && input.name !== undefined ? input.name : current!.name, fields: [{ label: 'Catalog', after: input.catalog_id }, { label: 'Business', after: input.business_id }, ...(!create ? [{ label: 'Product set', after: current!.id }] : []), ...('name' in data ? [{ label: 'Name', before: current?.name, after: data.name }] : []), ...('filter' in data ? [{ label: 'Filter', before: current ? filterText(current.filter) : undefined, after: filterText(data.filter!) }] : []), ...(remove ? [{ label: 'Definition removed', after: filterText(current!.filter) }] : [])], notices: notes },
      execute: async () => { const fresh = await prepare();let id = current?.id;try {
        if (remove) { const response = await this.client.delete<unknown>('product_sets/' + encodeURIComponent(id!));if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw invalid();await this.catalogs.authorize(selected, true);if (await this.set({ ...selected, product_set_id: id! }, true)) throw invalid(); }
        else {
          const raw = create ? (await this.client.post<unknown>('product_catalogs/' + encodeURIComponent(input.catalog_id) + '/product_sets', { data })).data : (await this.client.patch<unknown>('product_sets/' + encodeURIComponent(id!), { data })).data, known = z.object({ id: redditCatalogId }).safeParse(raw);if (create && known.success) id = known.data.id;
          const receipt = setRow.safeParse(raw);if (!receipt.success || receipt.data.id !== id || receipt.data.catalog_id !== input.catalog_id) throw invalid();await this.catalogs.authorize(selected, true);
          const actual = (await this.set({ ...selected, product_set_id: id! }))!, expected = create ? { id: id!, catalog_id: input.catalog_id, name: (input as z.infer<typeof setCreate>).name, filter: (input as z.infer<typeof setCreate>).filter } : { ...fresh!, ...data };
          if (canonical(setConfig(actual)) !== canonical(setConfig(expected))) throw invalid();
        }
        return [id!];
      } catch (error) { throw failure(error, 'Product-set mutation or independent preservation/absence readback is unconfirmed.', id ? [id] : undefined); } } };
  }
}
