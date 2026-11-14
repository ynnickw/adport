import { z } from 'zod';
import { catalogInput, hash } from './catalog-schemas.js';
import { productId } from './catalog-content-schemas.js';

const text = z.string().max(40_000), optionalText = text.nullable().optional();
const url = z.string().max(8192).url().refine(value => { const parsed = new URL(value);return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; }, 'Use an HTTP(S) URL without credentials');
const money = z.string().regex(/^\d+(?:\.\d+)? [A-Z]{3}$/).max(256);
const number = z.number().int().safe().nullable().optional();
const period = z.string().max(256).refine(value => { const parts = value.split('/');return parts.length === 2 && parts.every(v => /T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(v) && Number.isFinite(Date.parse(v))) && Date.parse(parts[0]!) < Date.parse(parts[1]!); }, 'Use an ordered ISO datetime interval with timezones');
/** All 45 writable fields in the official v3 batch-upsert contract, refreshed 2026-11-06. */
export const catalogProduct = z.object({
  id: productId, title: optionalText, description: optionalText, price: money.nullable().optional(), link: url.nullable().optional(), image_link: url.nullable().optional(),
  item_group_id: optionalText, sale_price: money.nullable().optional(), sale_price_effective_date: period.nullable().optional(), cost_of_goods_sold: money.nullable().optional(),
  mobile_link: url.nullable().optional(), platform_specific_link: z.object({ android: url.nullable().optional(), ios: url.nullable().optional() }).strict().nullable().optional(),
  lifestyle_image_link: url.nullable().optional(), additional_image_links: z.array(url).max(10).refine(values => new Set(values).size === values.length).nullable().optional(),
  product_type: optionalText, product_detail: optionalText, product_highlight: optionalText, google_product_category: optionalText, brand: optionalText, gtin: optionalText, mpn: optionalText,
  size: optionalText, size_type: optionalText, condition: optionalText, color: optionalText, gender: optionalText, material: optionalText, pattern: optionalText, age_group: optionalText,
  adult: z.boolean().nullable().optional(), is_bundle: z.boolean().nullable().optional(),
  custom_label_0: optionalText, custom_label_1: optionalText, custom_label_2: optionalText, custom_label_3: optionalText, custom_label_4: optionalText,
  custom_number_0: number, custom_number_1: number, custom_number_2: number, custom_number_3: number, custom_number_4: number,
  expiration_date: z.iso.datetime({ offset: true }).nullable().optional(), average_review_rating: optionalText, number_of_ratings: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  availability: z.enum(['BACKORDER', 'IN_STOCK', 'OUT_OF_STOCK', 'PREORDER']).optional(),
}).strict();
export const completeCatalogProduct = catalogProduct.extend({ title: text.min(1), description: text.min(1), price: money, link: url, image_link: url, availability: z.enum(['BACKORDER', 'IN_STOCK', 'OUT_OF_STOCK', 'PREORDER']) });
export const productIds = z.array(productId).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Select unique external product SKUs');
export const productContext = catalogInput.extend({ product_ids: productIds }).strict();
const write = catalogInput.omit({ account_id: true }).extend({ expected_selection_hash: hash, acknowledge_shared_effects: z.literal(true) });
const batch = <T extends z.ZodType<{ id: string }>>(schema: T) => z.array(schema).min(1).max(100).refine(rows => new Set(rows.map(row => row.id)).size === rows.length, 'Select unique external product SKUs');
export const productsCreate = write.extend({ products: batch(completeCatalogProduct) }).strict();
export const productsUpdate = write.extend({ products: batch(catalogProduct.refine(row => Object.keys(row).some(key => key !== 'id'), 'Provide a product field to change')) }).strict();
export const productsDelete = write.extend({ product_ids: productIds, acknowledge_permanent_deletion: z.literal(true) }).strict();
