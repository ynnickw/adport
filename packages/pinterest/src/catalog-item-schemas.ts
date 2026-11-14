import { z } from 'zod';
import { pinterestId } from './schemas.js';
import { groupId, groupHash, catalogType } from './product-group-schemas.js';
import { filterEnums } from './product-group-filter-spec.js';
import { itemAttributeSchemas, itemLanguages, itemUpdateMask } from './catalog-item-attributes.js';

export const itemOperation = z.enum(['CREATE', 'UPDATE', 'UPSERT', 'DELETE']);
export const sourceId = z.string().min(1).max(1024).regex(/^[^\x00-\x1f\x7f]+$/);
export const itemObject = z.record(z.string(), z.json());
export const itemSelection = z.object({ account_id: pinterestId, catalog_id: groupId, country: z.enum(filterEnums.Country), language: z.enum(itemLanguages) }).strict();
export const itemRead = itemSelection.extend({ item_ids: z.array(sourceId).min(1).max(1000).refine(ids => new Set(ids).size === ids.length), limit: z.number().int().min(1).max(100).default(24), cursor: z.string().min(1).max(8192).optional() });
const itemMutationBase = z.object({ source_id: sourceId, operation: itemOperation, attributes: itemObject.optional(), clear_fields: z.array(itemUpdateMask).min(1).max(100).refine(values => new Set(values).size === values.length).optional(), last_updated_time: z.number().int().nonnegative().safe().optional() }).strict();
export const itemMutation = itemMutationBase.superRefine((value, ctx) => {
  if (value.operation === 'DELETE' ? value.attributes !== undefined || value.clear_fields !== undefined : value.attributes === undefined || value.last_updated_time !== undefined || value.operation !== 'UPDATE' && value.clear_fields !== undefined) ctx.addIssue({ code: 'custom', message: 'CREATE/UPSERT/UPDATE require attributes; only UPDATE supports clear_fields; only DELETE accepts last_updated_time' });
  if (value.operation === 'UPDATE' && !Object.keys(value.attributes ?? {}).length && !value.clear_fields?.length) ctx.addIssue({ code: 'custom', message: 'Supply changed attributes or explicit clear_fields' });
  if (value.clear_fields?.some(key => Object.hasOwn(value.attributes ?? {}, key))) ctx.addIssue({ code: 'custom', message: 'A field cannot be both supplied and cleared' });
});
export const itemMedia = z.object({ item_index: z.number().int().min(0).max(999), field: z.string().regex(/^(?:image_link|video_link|additional_image_link|main_image\.link|ad_image_(?:[0-9]|1[0-9])_link|ad_video_[0-2]_link)$/), image_index: z.number().int().min(0).max(999).optional(), media_id: z.string().uuid(), expected_sha256: groupHash }).strict();
export const itemRequest = z.object({ operations: z.array(itemMutation).min(1).max(1000).refine(rows => new Set(rows.map(row => row.source_id)).size === rows.length, 'Each item may appear only once in a batch'), media_assets: z.array(itemMedia).max(1000).default([]), acknowledge_replacement: z.literal(true).optional(), acknowledge_unconfirmed_existing: z.literal(true).optional() }).strict();
export const itemContext = itemSelection.extend(itemRequest.shape);
const write = itemSelection.omit({ account_id: true }).extend({ expected_context_hash: groupHash, confirm_publication: z.literal(true), acknowledge_catalog_effects: z.literal(true), confirm_permanent_deletion: z.literal(true).optional() });
export const itemBatchApply = write.extend(itemRequest.shape).superRefine((value, ctx) => {
  if (value.operations.some(row => row.operation === 'UPSERT') && !value.acknowledge_replacement) ctx.addIssue({ code: 'custom', message: 'UPSERT replaces full item attributes; acknowledge_replacement is required' });
  if (value.operations.some(row => row.operation === 'DELETE') && !value.confirm_permanent_deletion) ctx.addIssue({ code: 'custom', message: 'Catalog deletion affects all data sources; confirm_permanent_deletion is required' });
});
export const itemNamedApply = (operation: z.infer<typeof itemOperation>) => write.extend({
  items: z.array(itemMutationBase.omit({ operation: true })).min(1).max(1000), media_assets: itemRequest.shape.media_assets,
  acknowledge_replacement: z.literal(true).optional(), acknowledge_unconfirmed_existing: z.literal(true).optional(),
}).superRefine((value, ctx) => {
  const result = itemBatchApply.safeParse({ ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'items')), operations: value.items.map(row => ({ ...row, operation })) });
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
});
export const itemCopy = itemSelection.omit({ account_id: true }).extend({ source_id: sourceId, expected_snapshot_hash: groupHash, title: z.string().max(65_536).optional(), description: z.string().max(65_536).optional(), confirm_publication: z.literal(true), acknowledge_catalog_effects: z.literal(true) }).strict().refine(value => value.title !== undefined || value.description !== undefined, 'Supply copy to change');
export const batchReference = z.object({ account_id: pinterestId, batch_receipt: z.string().min(100).max(2_000_000) }).strict();
export const itemSchemaQuery = z.object({ catalog_type: catalogType, operation: itemOperation }).strict();
export function attributeSchema(type: z.infer<typeof catalogType>, operation: z.infer<typeof itemOperation>) {
  if (operation === 'DELETE') return z.object({}).strict();
  return type === 'RETAIL' ? operation === 'UPDATE' ? itemAttributeSchemas.retailUpdate : itemAttributeSchemas.retailCreate : type === 'HOTEL' ? operation === 'UPDATE' ? itemAttributeSchemas.hotelUpdate : itemAttributeSchemas.hotelCreate : operation === 'UPDATE' ? itemAttributeSchemas.creativeUpdate : itemAttributeSchemas.creativeCreate;
}
export const itemIdField = { RETAIL: 'item_id', HOTEL: 'hotel_id', CREATIVE_ASSETS: 'creative_assets_id' } as const;
export const itemIdsField = { RETAIL: 'item_ids', HOTEL: 'hotel_ids', CREATIVE_ASSETS: 'creative_assets_ids' } as const;
export const itemWriteOperations = { pinterest_create_catalog_items: 'CREATE', pinterest_update_catalog_items: 'UPDATE', pinterest_upsert_catalog_items: 'UPSERT', pinterest_delete_catalog_items: 'DELETE' } as const;
