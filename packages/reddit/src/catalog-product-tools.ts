import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { RedditAdsProvider } from './provider.js';
import { productContext, productsCreate, productsUpdate, productsDelete } from './catalog-product-schemas.js';

export function redditCatalogProductTools(provider: RedditAdsProvider): AnyToolDefinition[] {
  const catalog = { category: 'creatives' as const, exposure: 'specialist' as const }, write = { namespace: 'reddit', provider: 'reddit', catalog };
  return [
    defineTool({ name: 'reddit_catalog_product_context', namespace: 'reddit', catalog, annotations: { readOnly: true }, presentation: 'records', description: 'Read up to 100 exact external SKUs in one granted Business catalog, exhausting scoped native pagination. Returns a selection_hash and present/absent state for manual product changes; not a global inventory.', input: productContext, output: z.looseObject({ records: z.array(z.record(z.string(), z.unknown())) }), handler: input => provider.catalogProducts.context(input) }),
    guardedWriteTool({ ...write, name: 'reddit_create_catalog_products', kind: 'create', destructive: false, description: 'Create up to 100 absent SKUs through native batch upsert with fresh selection_hash and complete product copy/price/URLs. Rechecks absence, uses normal approval and independent readback. Native concurrent upsert races and feed overwrites remain possible.', payload: productsCreate }),
    guardedWriteTool({ ...write, name: 'reddit_update_catalog_products', kind: 'update', destructive: true, description: 'Update selected fields on up to 100 existing external SKUs with current selection_hash. Merges all known writable fields, refuses unknown configuration, verifies complete readback and reports uncertain/partial outcomes without replay.', payload: productsUpdate }),
    guardedWriteTool({ ...write, name: 'reddit_delete_catalog_products', kind: 'remove', destructive: true, description: 'Permanently delete up to 100 exact present external SKUs with selection_hash and explicit acknowledgement. Verifies per-SKU native receipts and exhausted absence readback. Feeds can recreate products; internal Reddit IDs are not SKUs.', payload: productsDelete }),
  ];
}
