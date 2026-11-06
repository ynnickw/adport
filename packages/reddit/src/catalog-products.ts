import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AdportError, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import type { RedditAdsClient } from './client.js';
import type { RedditCatalogService } from './catalogs.js';
import { redditCatalogId } from './catalog-access.js';
import { catalogInput } from './catalog-schemas.js';
import { catalogProduct, completeCatalogProduct, productContext, productsCreate, productsUpdate, productsDelete } from './catalog-product-schemas.js';
import { productId } from './catalog-content-schemas.js';

type Scope = z.infer<typeof catalogInput>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<WriteResult> };
const nativeProduct = z.object({ id: productId, reddit: z.object({ id: redditCatalogId.optional(), catalog_id: redditCatalogId }).passthrough() }).catchall(z.json());
type Product = z.infer<typeof nativeProduct>;
const keys = new Set(Object.keys(catalogProduct.shape));
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const config = (row: Product) => Object.fromEntries(Object.entries(row).filter(([key]) => keys.has(key)));
const snapshot = (row: Product) => ({ ...config(row), reddit_id: row.reddit.id, created_at: row.created_at, modified_at: row.modified_at, unknown: Object.fromEntries(Object.entries(row).filter(([key]) => !keys.has(key) && !['reddit', 'created_at', 'modified_at'].includes(key))) });
const normalized = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([, value]) => value != null));
const invalid = () => new AdportError('PROVIDER_ERROR', 'Reddit product selection scope, pagination or native receipt could not be verified.');
const notes = ['Products belong to a shared Business catalog. These changes can affect existing product sets and ads; no ads, spend or conversion events are submitted.', 'Native batch upsert has no conditional-write guarantee. Concurrent feed/product writers can race the final preflight; scheduled feeds can overwrite these changes or recreate deleted products.', 'Updates send all currently known writable fields, merged with the selected changes. Readback checks the complete known configuration. Unknown fields refuse an update; absent optional fields and null are equivalent only for verification.', 'There is no native server dry run or atomic batch guarantee. Partial or uncertain outcomes consume approval and are never replayed automatically. Reconcile each selected SKU before another preview.'];

export class RedditCatalogProducts {
  constructor(private readonly client: Pick<RedditAdsClient, 'get' | 'post' | 'nextUrl'>, private readonly catalogs: RedditCatalogService) {}
  private async selected(input: Scope, ids: string[]): Promise<Product[]> {
    const url = new URL('https://ads-api.reddit.com/api/v3/product_catalogs/' + encodeURIComponent(input.catalog_id) + '/products');
    url.searchParams.set('page.size', '1000');for (const id of ids) url.searchParams.append('ids', id);
    const first = url.href, seen = new Set<string>(), rows: Product[] = [];let current = first;
    for (let page = 0; page < 10; page++) {
      if (seen.has(current)) throw invalid();seen.add(current);
      const response = await this.client.get<unknown>(current), parsed = z.array(nativeProduct).max(1000).safeParse(response.data), pagination = z.object({ next_url: z.string().url().max(8192).nullable().optional() }).safeParse(response.pagination);
      if (!parsed.success || !pagination.success) throw invalid();
      for (const row of parsed.data) { if (row.reddit.catalog_id !== input.catalog_id || !ids.includes(row.id) || rows.some(previous => previous.id === row.id)) throw invalid();rows.push(row); }
      if (!pagination.data.next_url) return rows.sort((a, b) => a.id.localeCompare(b.id));
      const next = new URL(this.client.nextUrl(pagination.data.next_url, first)), nextIds = next.searchParams.getAll('ids');
      if ([...next.searchParams.keys()].some(key => !['ids', 'page.token', 'page.size'].includes(key)) || !next.searchParams.get('page.token') || nextIds.length && canonical([...nextIds].sort()) !== canonical([...ids].sort())) throw invalid();
      // Native cursors may omit filters: repeat the exact opaque SKUs on every page.
      next.searchParams.delete('ids');for (const id of ids) next.searchParams.append('ids', id);next.searchParams.set('page.size', '1000');current = next.href;
    }
    throw new AdportError('PROVIDER_ERROR', 'Reddit selected-product verification exceeded ten pages; missing SKUs cannot be inferred.');
  }
  private async selection(input: Scope, ids: string[], write = false) {
    const parent = await this.catalogs.authorize(input, write), products = await this.selected(input, ids);
    return { products, selection_hash: digest({ ...input, catalog_configuration_hash: parent.configuration_hash, product_ids: [...ids].sort(), products: products.map(snapshot) }) };
  }
  async context(value: unknown) {
    const input = productContext.parse(value), selected = { account_id: input.account_id, business_id: input.business_id, catalog_id: input.catalog_id }, result = await this.selection(selected, input.product_ids);
    return { selection_hash: result.selection_hash, records: input.product_ids.map(id => { const row = result.products.find(row => row.id === id);return { id, name: typeof row?.title === 'string' ? row.title : id, state: row ? 'Present' : 'Absent' }; }), products: result.products.map(row => ({ ...config(row), reddit_id: row.reddit.id })), missing_product_ids: input.product_ids.filter(id => !result.products.some(row => row.id === id)), complete: true, truncated: false, notes: ['External product SKUs are distinct from Reddit-assigned internal product IDs. The hash binds this exact account/Business/catalog and exhausted selected-product snapshot; it is not a frozen global inventory.', ...notes] };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const create = op.tool === 'reddit_create_catalog_products', update = op.tool === 'reddit_update_catalog_products', remove = op.tool === 'reddit_delete_catalog_products';
    if (op.provider !== 'reddit' || !(create && op.kind === 'create' || update && op.kind === 'update' || remove && op.kind === 'remove')) throw new AdportError('INVALID_INPUT', 'Reddit product operation/provider kind mismatch.');
    const input = create ? productsCreate.parse(op.payload) : update ? productsUpdate.parse(op.payload) : productsDelete.parse(op.payload), scope = { account_id: op.accountId, business_id: input.business_id, catalog_id: input.catalog_id }, ids = 'products' in input ? input.products.map(row => row.id) : input.product_ids;
    const prepare = async () => {
      const result = await this.selection(scope, ids, true);
      if (result.selection_hash !== input.expected_selection_hash) throw new AdportError('PENDING_MISMATCH', 'Catalog or selected products changed; read the product context and preview again.');
      if (create ? result.products.length !== 0 : result.products.length !== ids.length) throw new AdportError('INVALID_INPUT', create ? 'Create requires every selected SKU to be absent.' : 'Update/delete requires every selected external SKU to be present.');
      const products = 'products' in input ? input.products.map(row => {
        const before = result.products.find(previous => previous.id === row.id);
        if (before && Object.keys(before).some(key => !keys.has(key) && !['reddit', 'created_at', 'modified_at'].includes(key))) throw new AdportError('INVALID_INPUT', 'A selected product has unknown fields; its configuration cannot be preserved by this update.');
        return completeCatalogProduct.parse({ ...(before ? config(before) : {}), ...row });
      }) : [];
      if (Buffer.byteLength(JSON.stringify({ data: remove ? ids : products }), 'utf8') > 1_000_000) throw new AdportError('INVALID_INPUT', 'Product batch exceeds the 1 MB Adport bound; use a smaller selection.');
      return { before: result.products, products };
    };
    const initial = await prepare(), title = create ? 'Create catalog products' : update ? 'Update catalog products' : 'Delete catalog products permanently';
    return { summary: `${title} · ${ids.length} selected`, changes: ids.map(id => `${create ? '+' : remove ? '-' : '~'} Product ${id}`), coercions: [], budgetDeltas: [], notes,
      review: { provider: 'reddit', accountId: op.accountId, kind: op.kind, title, subject: `${ids.length} selected products`, fields: [{ label: 'Business', after: scope.business_id }, { label: 'Catalog', after: scope.catalog_id }, ...ids.map(id => ({ label: id, ...(create ? {} : { before: config(initial.before.find(row => row.id === id)!) }), after: remove ? 'Permanently deleted' : initial.products.find(row => row.id === id) }))], notices: notes },
      execute: async () => {
        const fresh = await prepare();let outcomes: Array<{ id?: string; status: string }> = [];
        try {
          const response = await this.client.post<unknown>('product_catalogs/' + encodeURIComponent(scope.catalog_id) + '/products/' + (remove ? 'batch_delete' : 'batch_upsert'), { data: remove ? ids : fresh.products });
          let receiptValid = false;
          if (remove) {
            const parsed = z.record(z.string(), z.enum(['DELETED', 'NOT_FOUND'])).safeParse(response.data);
            if (parsed.success) { outcomes = Object.entries(parsed.data).filter(([id]) => ids.includes(id)).map(([id, status]) => ({ id, status }));receiptValid = Object.keys(parsed.data).length === ids.length && ids.every(id => Object.hasOwn(parsed.data, id)); }
          } else {
            const parsed = z.array(z.object({ status: z.enum(['CREATED', 'UPDATED', 'INVALID', 'UNCHANGED']), product: nativeProduct.nullable().optional() })).max(100).safeParse(response.data);
            if (parsed.success) {
              outcomes = parsed.data.map(row => ({ ...(row.product && ids.includes(row.product.id) ? { id: row.product.id } : {}), status: row.status }));
              receiptValid = parsed.data.length === ids.length && parsed.data.every(row => (create ? row.status === 'CREATED' : ['UPDATED', 'UNCHANGED'].includes(row.status)) && row.product && row.product.reddit.catalog_id === scope.catalog_id && ids.includes(row.product.id)) && new Set(outcomes.map(row => row.id)).size === ids.length;
            }
          }
          await this.catalogs.authorize(scope, true);const actual = await this.selected(scope, ids);
          const verified = remove ? ids.filter(id => !actual.some(row => row.id === id)) : fresh.products.filter(expected => { const row = actual.find(row => row.id === expected.id);return row && canonical(normalized(config(row))) === canonical(normalized(expected)); }).map(row => row.id);
          if (!receiptValid || verified.length !== ids.length) throw new AdportError('PROVIDER_ERROR', 'Native batch receipt or independent product configuration/absence readback is unconfirmed.', { verified_product_ids: verified });
          return { applied: true, resourceIds: ids, details: { outcomes, independently_verified: true }, warnings: [...notes.slice(0, 2), ...(outcomes.some(row => row.status === 'NOT_FOUND') ? ['Some SKUs were already absent at native deletion; they are not reported as deleted by this request.'] : [])] };
        } catch (error) {
          const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
          throw new AdportError('PROVIDER_ERROR', 'Reddit product batch outcome may be partial or unknown. No mutation was retried; reconcile selected SKUs before another preview.', { resourceIds: ids, outcomes, ...(Number.isInteger(details.http_status) ? { http_status: details.http_status } : {}), ...(Array.isArray(details.verified_product_ids) ? { verified_product_ids: details.verified_product_ids } : {}) });
        }
      } };
  }
}
