import { z } from 'zod';
import { pinterestId } from './schemas.js';
import { filterEnums, filterFields } from './product-group-filter-spec.js';

export const catalogType = z.enum(['RETAIL', 'HOTEL', 'CREATIVE_ASSETS']);
export const groupId = pinterestId, groupHash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(1024), negated = z.boolean().optional();
const strings = z.array(text).min(1).max(100), numericOperator = z.enum(['GREATER_THAN', 'GREATER_THAN_OR_EQUALS', 'LESS_THAN', 'LESS_THAN_OR_EQUALS']);
const criteria: Record<string, z.ZodType> = {
  CatalogsProductGroupMultipleStringCriteria: z.object({ values: strings, negated }).strict(),
  CatalogsProductGroupMultipleStringListCriteria: z.object({ values: z.array(strings).min(1).max(100), negated }).strict(),
  CatalogsProductGroupFilterOperatorTypeCriteria: z.object({ values: strings, negated, filter_operator_type: z.enum(['IS', 'CONTAINS']).optional() }).strict(),
  CatalogsProductGroupPricingCriteria: z.object({ values: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER), negated, inclusion: z.boolean().optional() }).strict(),
  CatalogsProductGroupUint32Criteria: z.object({ value: z.number().int().min(0).max(4_294_967_295), negated, operator: numericOperator }).strict(),
  CatalogsProductGroupCurrencyCriteria: z.object({ values: z.enum(filterEnums.NonNullableCatalogsCurrency), negated: z.literal(false).optional() }).strict(),
  CatalogsProductGroupMultipleGenderCriteria: z.object({ values: z.array(z.enum(filterEnums.Gender)).min(1).max(100), negated }).strict(),
  CatalogsProductGroupMultipleCountriesCriteria: z.object({ values: z.array(z.enum(filterEnums.Country)).min(1).max(100), negated }).strict(),
  CatalogsProductGroupMultipleMediaTypesCriteria: z.object({ values: z.array(z.enum(filterEnums.MediaType)).min(1).max(100), negated }).strict(),
  CatalogsProductGroupMultiplePinterestProductCategoryCriteria: z.object({ values: z.array(z.enum(filterEnums.ProductCategoryEnum)).min(1).max(100), negated }).strict(),
  PriceFilterPrice: z.object({ currency: z.enum(filterEnums.NonNullableCatalogsCurrency), negated, operator: numericOperator, value: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
};
export function productGroupFilterSchema(type: z.infer<typeof catalogType>, allowEmpty = false) {
  const fields = Object.entries(filterFields[type]).map(([key, value]) => z.object({ [key]: criteria[value]! }).strict());
  const clause = z.union([fields[0]!, fields[1]!, ...fields.slice(2)]);
  const list = z.array(clause).min(allowEmpty ? 0 : 1).max(32);
  return z.union([z.object({ any_of: list }).strict(), z.object({ all_of: list }).strict()]);
}
// Keep large native enums on demand; every supplied filter is validated against
// the same pinned Zod schema before preview or native use, never silently dropped.
export const groupFilters = z.record(z.string(), z.json()).refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 262_144, 'Filters exceed the 256 KiB Adport bound');
export const groupDefinition = z.object({
  mode: z.enum(['FEED', 'CATALOG']), catalog_type: catalogType, feed_id: groupId.optional(),
  name: text, description: z.string().max(10_000).nullable().optional(), filters: groupFilters,
  country: z.enum(filterEnums.Country).optional(), locale: z.enum(filterEnums.CatalogsLocale).optional(),
  confirm_all_products: z.literal(true).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.mode === 'FEED' ? value.catalog_type !== 'RETAIL' || !value.feed_id || value.country !== undefined || value.locale !== undefined : value.feed_id !== undefined || value.catalog_type !== 'RETAIL' && (value.country !== undefined || value.locale !== undefined)) ctx.addIssue({ code: 'custom', message: 'FEED mode requires RETAIL and feed_id without country/locale; CATALOG mode forbids feed_id and supports country/locale only for RETAIL' });
  validateGroupFilters(value.catalog_type, value.filters, value.confirm_all_products, ctx);
});
export function validateGroupFilters(type: z.infer<typeof catalogType>, filters: z.infer<typeof groupFilters>, all: boolean | undefined, ctx: z.RefinementCtx) {
  if (!productGroupFilterSchema(type, type !== 'RETAIL' && all === true).safeParse(filters).success) ctx.addIssue({ code: 'custom', message: 'Invalid native filter shape, field, enum or bound. Call pinterest_product_group_filter_schema; empty non-retail filters require confirm_all_products.' });
}
export const groupChanges = z.object({ name: text.optional(), description: z.string().max(10_000).nullable().optional(), filters: groupFilters.optional(), country: z.enum(filterEnums.Country).optional(), locale: z.enum(filterEnums.CatalogsLocale).optional(), confirm_all_products: z.literal(true).optional() }).strict().refine(value => Object.keys(value).some(key => key !== 'confirm_all_products'), 'Supply at least one setting');
const selection = { catalog_id: groupId }, reference = { ...selection, product_group_id: groupId };
export const groupCreate = z.object({ ...selection, expected_context_hash: groupHash, definition: groupDefinition }).strict();
export const groupUpdate = z.object({ ...reference, expected_context_hash: groupHash, changes: groupChanges, acknowledge_live_effects: z.literal(true) }).strict();
export const groupDelete = z.object({ ...reference, expected_context_hash: groupHash, confirm_name: z.string().min(1).max(1024), acknowledge_live_effects: z.literal(true), confirm_permanent_deletion: z.literal(true) }).strict();
export const groupAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), definition: groupDefinition }).strict(),
  z.object({ kind: z.literal('update'), product_group_id: groupId, changes: groupChanges }).strict(),
  z.object({ kind: z.literal('delete'), product_group_id: groupId, confirm_name: z.string().min(1).max(1024) }).strict(),
]);
export const groupContext = z.object({ account_id: groupId, ...selection, action: groupAction }).strict();
export const groupPaging = { page_size: z.number().int().min(1).max(250).default(25), bookmark: z.string().min(1).max(8192).optional() };
export const groupList = z.object({ account_id: groupId, ...selection, feed_id: groupId.optional(), product_group_ids: z.array(groupId).min(1).max(100).refine(ids => new Set(ids).size === ids.length).optional(), ...groupPaging }).strict();
export const groupReference = z.object({ account_id: groupId, ...reference }).strict();
export const nativeGroup = z.looseObject({ id: groupId, catalog_id: groupId, catalog_type: catalogType, name: z.string().max(1024).optional(), description: z.string().max(10_000).nullable().optional(), filters: groupFilters, feed_id: groupId.nullable().optional(), type: z.string().optional(), country: z.string().nullable().optional(), locale: z.string().nullable().optional(), created_at: z.number().int().safe().optional(), updated_at: z.number().int().safe().optional() }).superRefine((value, ctx) => {
  if (value.catalog_type === 'RETAIL' && (!Object.hasOwn(value, 'feed_id') || !value.type) || value.catalog_type === 'HOTEL' && !value.type) ctx.addIssue({ code: 'custom', message: 'Missing native product group mode/type' });
});
