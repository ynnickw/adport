import { createHash } from 'node:crypto';
import { verifyMedia } from '@adport/core';
import { PinterestAdsProvider } from '../src/provider.js';
import { itemIdField, itemIdsField } from '../src/catalog-item-schemas.js';
import { productGroupFixture, PG_ACCOUNT, PG_CATALOG, type PGType } from './product-group-fixture.js';

type Row = Record<string, any>;
type Call = { url: URL; init: RequestInit; body?: Row };
export const CI_ACCOUNT = PG_ACCOUNT, CI_CATALOG = PG_CATALOG, CI_ID = 'synthetic-item', CI_NEW = 'new-synthetic-item', CI_BATCH = 'b3521697762511549164', CI_MEDIA = 'ccd3710c-594a-4c31-8cc0-3f0317213154';
export const CI_PRIVATE = 'https://storage.example.test/private.png?token=PRIVATE-LINK';
export function catalogItemFixture(type: PGType = 'RETAIL') {
  const f = productGroupFixture(type), attrs: Row = type === 'RETAIL' ? { title: 'Synthetic shirt', description: 'Original description', price: '24.99 EUR', availability: 'in stock', image_link: ['https://image.example.test/item.png'], link: 'https://merchant.example.test/private?cap=PRIVATE', custom_label_0: 'Keep', native_future_setting: true } : type === 'HOTEL' ? { name: 'Synthetic hotel', description: 'Original description', base_price: '100 EUR', latitude: 52.5, longitude: 13.4, main_image: { link: 'https://image.example.test/hotel.png' }, address: { city: 'Berlin', country: 'DE' } } : { title: 'Synthetic concept', description: 'Original description', image_link: 'https://image.example.test/creative.png', link: 'https://merchant.example.test/creative', visibility: 'HIDDEN', custom_label_0: 'Keep' };
  const state = { rows: new Map<string, Row>([[CI_ID, attrs]]), job: undefined as Row | undefined, nativeStatus: 'PROCESSING', jobItems: undefined as Row[] | undefined, scopeId: 'synthetic-project', bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), minted: 0, grant: { url: CI_PRIVATE, expires_at: new Date(Date.now() + 3600_000).toISOString() }, hook: undefined as undefined | ((call: Call) => Response | undefined) };
  const sha = () => createHash('sha256').update(state.bytes).digest('hex'), idKey = itemIdField[type], idsKey = itemIdsField[type], family = type === 'RETAIL' ? 'retail' : type === 'HOTEL' ? 'hotel' : 'creative_assets';
  const media = { get scopeId() { return state.scopeId; }, async read(source: { expected_sha256: string }, options?: { contentTypes?: readonly string[] }) { return verifyMedia(state.bytes, 'synthetic.png', source.expected_sha256, options); }, async providerUrl(source: { expected_sha256: string }) { state.minted++;return { ...state.grant, sha256: source.expected_sha256 }; } };
  f.state.hook = call => {
    const override = state.hook?.(call);if (override) return override;const path = call.url.pathname, body = call.body;
    if (path === '/v5/catalogs/items') {
      const ids = body!.filters[idsKey] as string[];
      return Response.json({ items: ids.map(id => state.rows.has(id) ? { catalog_type: type, item_response_kind: family + '_item', [idKey]: id, attributes: state.rows.get(id), pins: [{ title: String(state.rows.get(id)!.title ?? state.rows.get(id)!.name), media: { images: { '600x': { url: 'https://i.pinimg.com/600x/synthetic-preview.png', width: 600, height: 400 } } } }] } : { catalog_type: type, item_response_kind: family + '_item_error', [idKey]: id, errors: [{ code: 91001, attribute: 'ITEM_ID', message: 'Synthetic missing or inaccessible item; no native not-found code is inferred' }] }) });
    }
    if (path === '/v5/catalogs/items/batch') {
      const items = (body!.items as Row[]).map(item => {
        const id = item[idKey] as string;let error: Row | undefined;
        if (item.operation === 'CREATE' && state.rows.has(id)) error = { code: 99, attribute: 'ITEM_ID', message: 'Item already exists.' };
        else if (item.operation === 'UPDATE' && !state.rows.has(id)) error = { code: 91001, message: 'Synthetic inaccessible item' };
        else if (item.operation === 'DELETE') state.rows.delete(id);
        else {
          const values = { ...(item.operation === 'UPDATE' ? state.rows.get(id) : {}), ...item.attributes };
          for (const key of item.update_mask ?? []) if (!Object.hasOwn(item.attributes, key)) delete values[key];
          if (type === 'RETAIL' && typeof values.image_link === 'string') values.image_link = [values.image_link];state.rows.set(id, values);
        }
        return { [idKey]: id, status: error ? 'FAILURE' : 'PROCESSING', errors: error ? [error] : [], warnings: [] };
      });
      state.job = { batch_id: CI_BATCH, catalog_type: type, created_time: '2026-11-06T03:00:00', completed_time: null, status: state.nativeStatus, items };return Response.json(state.job);
    }
    if (path === '/v5/catalogs/items/batch/' + CI_BATCH) return Response.json({ ...state.job, status: state.nativeStatus, items: state.jobItems ?? state.job!.items.map((row: Row) => ({ ...row, status: row.status === 'FAILURE' ? 'FAILURE' : state.nativeStatus === 'COMPLETED' ? 'SUCCESS' : row.status })) });
    return undefined;
  };
  const provider = new PinterestAdsProvider(f.client, media), selection = { account_id: CI_ACCOUNT, catalog_id: CI_CATALOG, country: 'DE', language: 'de' }, writes = () => f.calls.filter(call => call.url.pathname === '/v5/catalogs/items/batch' && call.init.method === 'POST');
  const operations = (operation = 'UPDATE', id = CI_ID, attributes?: Row): Row[] => [{ source_id: id, operation, ...(operation === 'DELETE' ? {} : { attributes: attributes ?? (operation === 'UPDATE' ? type === 'HOTEL' ? { name: 'Edited hotel' } : { title: 'Edited title' } : type === 'HOTEL' ? { name: 'Created hotel', base_price: '100 EUR', main_image: { link: 'https://image.example.test/hotel.png' } } : type === 'CREATIVE_ASSETS' ? { title: 'Created concept', description: 'Description', image_link: 'https://image.example.test/creative.png', link: 'https://merchant.example.test' } : { title: 'Created shirt', description: 'Description', price: '25 EUR', availability: 'in stock', image_link: 'https://image.example.test/item.png', link: 'https://merchant.example.test' }) }) }];
  const context = (rows = operations(), extra: Row = {}) => provider.catalogItems.context({ ...selection, operations: rows, ...extra });
  const applyArgs = async (rows = operations(), extra: Row = {}) => ({ catalog_id: CI_CATALOG, country: 'DE', language: 'de', operations: rows, ...extra, expected_context_hash: (await context(rows, extra)).context_hash, confirm_publication: true, acknowledge_catalog_effects: true, ...(rows.some(row => row.operation === 'DELETE') ? { confirm_permanent_deletion: true } : {}) });
  return { ...f, provider, itemState: state, media, sha, selection, writes, operations, context, applyArgs };
}
