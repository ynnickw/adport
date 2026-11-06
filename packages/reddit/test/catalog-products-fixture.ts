import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RedditAdsClient } from '../src/client.js';
import { RedditAdsProvider } from '../src/provider.js';
import { FileRedditCatalogAccessStore, catalogGrant } from '../src/catalog-access.js';

export const PRODUCT_ACCOUNT = 'a2_qa', PRODUCT_BUSINESS = '1e200a0b-4e98-32cc-dd47-3006e4c85bb2', PRODUCT_CATALOG = 'catalog_qa';
export const productScope = { account_id: PRODUCT_ACCOUNT, business_id: PRODUCT_BUSINESS, catalog_id: PRODUCT_CATALOG };
export const newProduct = (id = 'sku,新/a') => ({ id, title: 'QA <script>', description: 'Synthetic product', price: '19.99 EUR', link: 'https://merchant.example.test/product', image_link: 'https://merchant.example.test/image.png', availability: 'IN_STOCK' as const });
export type ProductRow = Record<string, any> & { id: string; reddit: { id: string; catalog_id: string } };
type Call = { url: URL; method: string; body?: Record<string, any> };
export async function productFixture(mode: 'none' | 'read' | 'write' = 'write') {
  const dir = await mkdtemp(join(tmpdir(), 'adport-reddit-products-')), access = new FileRedditCatalogAccessStore(join(dir, 'grants')), resource = { accountId: PRODUCT_ACCOUNT, businessId: PRODUCT_BUSINESS, resourceId: PRODUCT_CATALOG, kind: 'catalog' as const };
  if (mode !== 'none') await access.compareAndSet(resource, catalogGrant(resource).hash, mode);
  const state = { catalog: { id: PRODUCT_CATALOG, business_id: PRODUCT_BUSINESS, name: 'QA catalog', default_currency: 'EUR', default_language: 'de', event_sources: [] }, products: [{ ...newProduct('existing/ä,sku'), brand: 'Preserved brand', custom_label_0: 'Connected platform', reddit: { id: 'native_product_1', catalog_id: PRODUCT_CATALOG } }] as ProductRow[], hook: undefined as undefined | ((call: Call) => Response | undefined) };
  const calls: Call[] = [], ok = (data: unknown, status = 200) => Response.json({ data, pagination: { next_url: null } }, { status });
  const client = new RedditAdsClient({ clientId: 'qa-client', clientSecret: 'qa-private-secret', refreshToken: 'qa-refresh', userAgent: 'desktop:adport:qa (by /u/qa)' }, async (raw, init = {}) => {
    const url = new URL(String(raw));if (url.pathname === '/api/v1/access_token') return Response.json({ access_token: 'qa-private-access', expires_in: 3600 });
    const call = { url, method: init.method!, body: init.body ? JSON.parse(String(init.body)) : undefined };calls.push(call);const override = state.hook?.(call);if (override) return override;
    if (call.method === 'GET') {
      if (url.pathname === '/api/v3/product_catalogs/' + PRODUCT_CATALOG) return ok(state.catalog);
      if (url.pathname === '/api/v3/product_catalogs/' + PRODUCT_CATALOG + '/products') return ok(state.products.filter(row => url.searchParams.getAll('ids').includes(row.id)));
    }
    if (call.method === 'POST' && url.pathname.endsWith('/batch_upsert')) {
      const rows = call.body!.data.map((product: Record<string, unknown>) => { const prior = state.products.find(row => row.id === product.id), next = { ...product, reddit: prior?.reddit ?? { id: 'native_new_' + state.products.length, catalog_id: PRODUCT_CATALOG } } as ProductRow;state.products = [...state.products.filter(row => row.id !== next.id), next];return { status: prior ? 'UPDATED' : 'CREATED', product: next }; });return ok(rows, 201);
    }
    if (call.method === 'POST' && url.pathname.endsWith('/batch_delete')) {
      const ids = call.body!.data as string[], receipt = Object.fromEntries(ids.map(id => [id, state.products.some(row => row.id === id) ? 'DELETED' : 'NOT_FOUND']));state.products = state.products.filter(row => !ids.includes(row.id));return ok(receipt);
    }
    throw new Error('Unexpected synthetic native route: ' + url.pathname);
  });
  const provider = new RedditAdsProvider(client, undefined, access), context = (ids: string[]) => provider.catalogProducts.context({ ...productScope, product_ids: ids });
  return { dir, access, resource, state, calls, client, provider, context, writes: () => calls.filter(call => call.method === 'POST'), args: async (ids: string[]) => ({ business_id: PRODUCT_BUSINESS, catalog_id: PRODUCT_CATALOG, expected_selection_hash: (await context(ids)).selection_hash, acknowledge_shared_effects: true as const }) };
}
