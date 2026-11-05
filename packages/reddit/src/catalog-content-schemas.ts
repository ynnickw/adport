import { z } from 'zod';
import { catalogInput, hash } from './catalog-schemas.js';
import { redditCatalogId } from './catalog-access.js';

export const productId = z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/);
export const page = { page_size: z.number().int().positive().max(1000).default(20), cursor: z.string().url().max(8192).optional() };
export const setInput = catalogInput.extend({ product_set_id: redditCatalogId }).strict();
export const setList = catalogInput.extend(page).strict();
export const productFilters = { ids: z.array(productId).min(1).max(100).refine(ids => new Set(ids).size === ids.length).optional(), approval_decision: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(), search: z.string().min(1).max(100).optional() };
export const productList = catalogInput.extend({ ...page, ...productFilters }).strict();
export const setProductList = setInput.extend({ ...page, ...productFilters, issue_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional() }).strict();
const attributes = new Set(['id', 'title', 'description', 'price', 'currency', 'sale_price', 'availability', 'brand', 'color', 'gender', 'product_type', 'item_group_id', 'condition', 'age_group', 'size', 'pattern', 'material', 'custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4']);
const operators = new Set(['contains', 'not_contains', 'i_contains', 'i_not_contains', 'starts_with', 'i_starts_with', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte']);
const arrayOperators = new Set(['is_any', 'is_not_any', 'i_is_any', 'i_is_not_any']);
/** Native filter is a JSON string. Validate its documented grammar without evaluating it. */
export function validFilter(value: string) {
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 500 || depth > 8 || !item || typeof item !== 'object' || Array.isArray(item)) return false;
    const entries = Object.entries(item);if (entries.length !== 1) return false;
    const [key, condition] = entries[0]!;
    if (key === 'and' || key === 'or') return Array.isArray(condition) && condition.length > 0 && condition.length <= 100 && condition.every(child => visit(child, depth + 1));
    if (!attributes.has(key) || !condition || typeof condition !== 'object' || Array.isArray(condition)) return false;
    const checks = Object.entries(condition);if (checks.length !== 1) return false;
    const [operator, operand] = checks[0]!;
    return operators.has(operator) ? typeof operand === 'string' && operand.length > 0 && operand.length <= 4000 : arrayOperators.has(operator) && Array.isArray(operand) && operand.length > 0 && operand.length <= 100 && operand.every(v => typeof v === 'string' && v.length > 0 && v.length <= 4000);
  };
  try { return visit(JSON.parse(value), 0); } catch { return false; }
}
export const setFilter = z.string().min(2).max(65_536).refine(validFilter, 'Use the documented Reddit product-filter JSON grammar');
export const setCreate = catalogInput.omit({ account_id: true }).extend({ name: z.string().min(1).max(100), filter: setFilter, expected_catalog_configuration_hash: hash, acknowledge_shared_effects: z.literal(true) }).strict();
export const setUpdate = setInput.omit({ account_id: true }).extend({ name: z.string().min(1).max(100).optional(), filter: setFilter.optional(), expected_configuration_hash: hash, acknowledge_shared_effects: z.literal(true) }).strict().refine(input => input.name !== undefined || input.filter !== undefined, 'Provide a name or filter');
export const setDelete = setInput.omit({ account_id: true }).extend({ expected_configuration_hash: hash, confirm_name: z.string().min(1).max(100), acknowledge_shared_effects: z.literal(true), acknowledge_remove_set: z.literal(true) }).strict();
export const importInput = catalogInput.extend({ import_id: redditCatalogId }).strict();
export const importList = catalogInput.extend({ ...page, feed_ids: z.array(redditCatalogId).min(1).max(100).refine(ids => new Set(ids).size === ids.length).optional(), statuses: z.array(z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED'])).min(1).max(5).refine(values => new Set(values).size === values.length).optional() }).strict();
export const importIssues = importInput.extend({ ...page, code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional() }).strict();
