import { PinterestAdsClient, PINTEREST_TOKEN_URL } from '../src/client.js';
import { PinterestAdsProvider } from '../src/provider.js';

export const PG_ACCOUNT = '549000000001', PG_CATALOG = '549000000002', PG_FEED = '549000000003', PG_ID = '549000000004', PG_CREATED = '549000000005';
export type PGType = 'RETAIL' | 'HOTEL' | 'CREATIVE_ASSETS';
type Row = Record<string, any>;
type Call = { url: URL; init: RequestInit; body?: Row };
export const groupFilters = (type: PGType): Row => ({ all_of: [type === 'RETAIL' ? { BRAND: { values: ['Synthetic brand'], negated: false } } : type === 'HOTEL' ? { HOTEL_ID: { values: ['synthetic-hotel'] } } : { MEDIA_TYPE: { values: ['IMAGE'] } }] });
export function productGroupFixture(type: PGType = 'RETAIL', mode: 'FEED' | 'CATALOG' = 'CATALOG') {
  const date = '2026-11-06T00:00:00Z', state = {
    owner: 'QA_OWNER', catalog: { id: PG_CATALOG, name: 'Synthetic catalog', catalog_type: type, created_at: date, updated_at: date } as Row,
    feed: { id: PG_FEED, catalog_type: type, catalog_id: PG_CATALOG, name: 'Synthetic feed', status: 'INACTIVE', format: 'CSV', default_locale: 'en-US', default_country: 'US', location: 'https://source.example.test/private.csv?secret=PRIVATE', created_at: date, updated_at: date } as Row,
    groups: [{ id: PG_ID, catalog_id: PG_CATALOG, catalog_type: type, name: 'Synthetic group', description: null, filters: groupFilters(type), created_at: 1793923200, updated_at: 1793923200, ...(type === 'RETAIL' ? { feed_id: mode === 'FEED' ? PG_FEED : null, type: 'MERCHANT_CREATED', status: 'ACTIVE', country: mode === 'FEED' ? null : 'US', locale: mode === 'FEED' ? null : 'en-US', is_featured: false } : type === 'HOTEL' ? { type: 'MERCHANT_CREATED' } : {}) }] as Row[],
    products: [{ catalog_type: type, metadata: type === 'RETAIL' ? { item_id: 'synthetic-sku', item_group_id: null, availability: 'IN_STOCK', currency: 'EUR', price: 24.99, sale_price: null } : type === 'HOTEL' ? { hotel_id: 'synthetic-hotel' } : { creative_assets_id: 'synthetic-creative', visibility: 'VISIBLE' }, pin: { title: 'Synthetic product', description: 'Metadata only', link: 'https://product.example.test' } }] as Row[],
    deleted: [] as string[], deleteStatus: 204, hook: undefined as undefined | ((call: Call) => Response | undefined),
  };
  const calls: Call[] = [], page = (url: URL, rows: Row[]) => { const start = Number((url.searchParams.get('bookmark') ?? 'native:0').split(':')[1]), count = Number(url.searchParams.get('page_size') ?? 25);return { items: rows.slice(start, start + count), bookmark: start + count < rows.length ? `native:${start + count}` : null }; };
  const client = new PinterestAdsClient({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh' }, async (raw, init = {}) => {
    const url = new URL(String(raw)), body = typeof init.body === 'string' && String(raw) !== PINTEREST_TOKEN_URL ? JSON.parse(init.body) as Row : undefined, call = { url, init, body };calls.push(call);
    if (String(raw) === PINTEREST_TOKEN_URL) return Response.json({ access_token: 'synthetic-access', expires_in: 3600 });
    const override = state.hook?.(call);if (override !== undefined) return override;
    const path = url.pathname;
    if (path === `/v5/ad_accounts/${PG_ACCOUNT}`) return Response.json({ id: PG_ACCOUNT, owner: { username: state.owner } });
    if (path === '/v5/catalogs') return Response.json({ items: [state.catalog], bookmark: null });
    if (path === '/v5/catalogs/feeds') return Response.json({ items: [state.feed], bookmark: null });
    if (path === `/v5/catalogs/feeds/${PG_FEED}`) return Response.json(state.feed);
    if (path === '/v5/catalogs/product_groups') {
      if (init.method === 'POST') { const created = { ...state.groups[0], id: PG_CREATED, name: body!.name, description: body!.description ?? null, filters: body!.filters, ...(type === 'RETAIL' ? { feed_id: body!.feed_id ?? null, country: body!.country ?? null, locale: body!.locale ?? null } : {}) };state.groups.push(created);return Response.json(created, { status: 201 }); }
      const ids = url.searchParams.get('id')?.split(','), rows = state.groups.filter(row => (!ids || ids.includes(row.id)) && (!url.searchParams.has('feed_id') || row.feed_id === url.searchParams.get('feed_id')));return Response.json(page(url, rows));
    }
    const match = path.match(/^\/v5\/catalogs\/product_groups\/(\d+)(?:\/(product_counts|products))?$/);
    if (match) {
      const row = state.groups.find(row => row.id === match[1]);if (!row) return Response.json({ code: 16, message: 'Synthetic resource missing' }, { status: 404 });
      if (match[2] === 'product_counts') return Response.json(type === 'RETAIL' ? { catalog_type: type, in_stock: 1, out_of_stock: 0, preorder: 0, total: 1 } : type === 'HOTEL' ? { catalog_type: type, total: 1 } : { catalog_type: type, videos: 0, images: 1, app_links: 0, total: 1 });
      if (match[2] === 'products') return Response.json(page(url, state.products));
      if (init.method === 'PATCH') { Object.assign(row, body, { updated_at: row.updated_at + 1 });return Response.json(row); }
      if (init.method === 'DELETE') { state.deleted.push(row.id);state.groups = state.groups.filter(group => group.id !== row.id);return state.deleteStatus === 204 ? new Response(null, { status: 204 }) : Response.json(row); }
      return Response.json(row);
    }
    throw new Error('Unexpected synthetic endpoint ' + init.method + ' ' + path);
  });
  const provider = new PinterestAdsProvider(client), writes = () => calls.filter(call => call.init.method !== 'GET' && call.url.href !== PINTEREST_TOKEN_URL);
  const definition = (): Row => ({ mode, catalog_type: type, name: 'Created synthetic group', filters: groupFilters(type), ...(mode === 'FEED' ? { feed_id: PG_FEED } : type === 'RETAIL' ? { country: 'US', locale: 'en-US' } : {}) });
  const context = (action: Row) => provider.productGroups.context({ account_id: PG_ACCOUNT, catalog_id: PG_CATALOG, action });
  const create = async (value = definition()) => ({ catalog_id: PG_CATALOG, definition: value, expected_context_hash: (await context({ kind: 'create', definition: value })).context_hash });
  const update = async (changes: Row = { name: 'Renamed group' }, id = PG_ID) => ({ catalog_id: PG_CATALOG, product_group_id: id, changes, acknowledge_live_effects: true, expected_context_hash: (await context({ kind: 'update', product_group_id: id, changes })).context_hash });
  const remove = async (id = PG_ID) => { const confirm_name = state.groups.find(row => row.id === id)!.name;return { catalog_id: PG_CATALOG, product_group_id: id, confirm_name, acknowledge_live_effects: true, confirm_permanent_deletion: true, expected_context_hash: (await context({ kind: 'delete', product_group_id: id, confirm_name })).context_hash }; };
  return { state, calls, client, provider, writes, definition, context, create, update, remove };
}
