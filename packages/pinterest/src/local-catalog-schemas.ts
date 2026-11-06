import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AdportError } from '@adport/core';
import { pinterestId } from './schemas.js';
import { groupHash, groupId } from './product-group-schemas.js';
import { filterEnums } from './product-group-filter-spec.js';
import { sourceId, itemOperation } from './catalog-item-schemas.js';

// Pinterest-owned OpenAPI5.28.0 at51aca009, inspected2026-11-06. The guide
// contains older route examples; current OpenAPI path/field shapes are used.
export type LocalRow = Record<string, unknown>;
export const localCanonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const localHash = (value: unknown) => createHash('sha256').update(localCanonical(value)).digest('hex');
export const localObject = (value: unknown): LocalRow => value && typeof value === 'object' && !Array.isArray(value) ? value as LocalRow : {};
export const localScope = z.object({ account_id: pinterestId, catalog_id: groupId }).strict();
export type LocalScope = z.infer<typeof localScope>;
export const localFailure = (error?: unknown, ids: string[] = [], extra: LocalRow = {}) => { const detail = error instanceof AdportError ? localObject(error.details) : {};return new AdportError('PROVIDER_ERROR', 'Pinterest local catalog operation is unconfirmed. No mutation was retried. Reconcile known IDs before preparing another approval; native bodies and private links are hidden.', { ...(typeof detail.http_status === 'number' ? { http_status: detail.http_status } : {}), ...(ids.length ? { resource_ids: [...new Set(ids)] } : {}), ...extra }); };
export function localBound(value: unknown) { if (Buffer.byteLength(localCanonical(value)) > 2 * 1024 * 1024) throw new AdportError('INVALID_INPUT', 'Local catalog request exceeds2MiB; split the batch.'); }
export function publicLocal(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map(item => publicLocal(item,key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name,item]) => [name,publicLocal(item,name)]));
  if (typeof value === 'string' && /url|link/i.test(key)) { try { return { origin: new URL(value).origin, fingerprint: localHash(value) }; } catch { return { fingerprint: localHash(value) }; } }
  return value;
}
const text = z.string().min(1).max(1024), address = z.string().max(4096);
export const localStoreDefinition = z.object({ store_code: sourceId, name: text, country: z.enum(filterEnums.Country), address_primary: address.optional(), address_secondary: address.optional(), city: address.optional(), region: address.optional(), postal_code: address.optional(), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional() }).strict();
export const localStoreChanges = localStoreDefinition.partial().extend({ id: groupId }).strict().refine(value => Object.keys(value).length > 1,'Supply a store setting');
export const nativeLocalStore = localStoreDefinition.extend({ id: groupId, created_at: z.string().min(1).max(100), updated_at: z.string().min(1).max(100) }).loose();
export const localStoreRemoval = z.object({ id: groupId, confirm_store_code: sourceId, confirm_name: text }).strict();
const unique = <T>(values: T[], key: (value: T) => string) => new Set(values.map(key)).size === values.length;
const createStores = z.array(localStoreDefinition).min(1).max(100).refine(rows => unique(rows,row => row.store_code),'Duplicate store code');
const updateStores = z.array(localStoreChanges).min(1).max(100).refine(rows => unique(rows,row => row.id),'Duplicate store ID');
const deleteStores = z.array(localStoreRemoval).min(1).max(100).refine(rows => unique(rows,row => row.id),'Duplicate store ID');
export const localStoreAction = z.discriminatedUnion('kind', [z.object({ kind: z.literal('create'), stores: createStores }).strict(), z.object({ kind: z.literal('update'), stores: updateStores, acknowledge_store_code_change: z.literal(true).optional() }).strict(), z.object({ kind: z.literal('delete'), stores: deleteStores }).strict()]);
export const localStoreContext = localScope.extend({ action: localStoreAction });
const storeWrite = localScope.omit({ account_id: true }).extend({ expected_context_hash: groupHash, acknowledge_catalog_effects: z.literal(true), confirm_publication: z.literal(true) });
export const localStoreCreate = storeWrite.extend({ stores: createStores });
export const localStoreUpdate = storeWrite.extend({ stores: updateStores, acknowledge_store_code_change: z.literal(true).optional() });
export const localStoreDelete = storeWrite.extend({ stores: deleteStores, confirm_permanent_deletion: z.literal(true) });
export const localStoreList = localScope.extend({ store_ids: z.array(groupId).min(1).max(100).refine(ids => new Set(ids).size === ids.length).optional(), page_size: z.number().int().min(1).max(250).default(25), bookmark: z.string().min(1).max(16_384).optional() });
export const inventoryPair = z.object({ item_id: sourceId, store_code: sourceId, store_id: groupId }).strict();
export const inventoryKey = (value: { item_id: string; store_code: string }) => localCanonical([value.item_id,value.store_code]);
export const inventoryAttributes = z.object({ price: z.string().min(1).max(1024), availability: z.enum(['in stock','out of stock','preorder']), sale_price: z.string().min(1).max(1024).optional(), ad_link: z.string().min(1).max(65_536).optional() }).strict();
const inventoryUpdate = inventoryAttributes.partial().refine(value => Object.keys(value).length > 0,'Supply changed attributes');
export const inventoryOperation = z.discriminatedUnion('operation', [
  inventoryPair.extend({ operation: z.literal('CREATE'), attributes: inventoryAttributes }), inventoryPair.extend({ operation: z.literal('UPSERT'), attributes: inventoryAttributes }), inventoryPair.extend({ operation: z.literal('UPDATE'), attributes: inventoryUpdate }), inventoryPair.extend({ operation: z.literal('DELETE') }),
]);
export const inventoryRequest = z.object({ operations: z.array(inventoryOperation).min(1).max(1000).refine(rows => unique(rows,inventoryKey),'Duplicate item/store pair'), acknowledge_replacement: z.literal(true).optional(), acknowledge_unconfirmed_existing: z.literal(true).optional() }).strict();
export const inventoryContext = localScope.extend(inventoryRequest.shape);
export const inventoryList = localScope.extend({ item_filters: z.array(inventoryPair).min(1).max(1000).refine(rows => unique(rows,inventoryKey),'Duplicate item/store pair'), limit: z.number().int().min(1).max(100).default(24), cursor: z.string().min(1).max(8192).optional() });
const inventoryWrite = storeWrite.extend(inventoryRequest.shape).superRefine((value,ctx) => { if (value.operations.some(row => row.operation === 'UPSERT') && !value.acknowledge_replacement) ctx.addIssue({ code:'custom',message:'UPSERT requires full replacement acknowledgement' });if (value.operations.some(row => row.operation === 'DELETE') && !('confirm_permanent_deletion' in value && value.confirm_permanent_deletion)) ctx.addIssue({ code:'custom',message:'DELETE requires confirm_permanent_deletion' }); });
export const inventoryBatch = inventoryWrite.safeExtend({ confirm_permanent_deletion: z.literal(true).optional() });
export const inventoryNamed = (operation: z.infer<typeof itemOperation>) => {
  const item=operation==='CREATE'?inventoryOperation.options[0].omit({operation:true}):operation==='UPSERT'?inventoryOperation.options[1].omit({operation:true}):operation==='UPDATE'?inventoryOperation.options[2].omit({operation:true}):inventoryOperation.options[3].omit({operation:true});
  return storeWrite.extend({ items: z.array(item).min(1).max(1000), acknowledge_replacement: z.literal(true).optional(), acknowledge_unconfirmed_existing: z.literal(true).optional(), confirm_permanent_deletion: z.literal(true).optional() }).superRefine((value,ctx) => { const { items,...common } = value, result = inventoryBatch.safeParse({ ...common,operations:items.map(row => ({ ...row,operation })) });if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ code:'custom',path:issue.path,message:issue.message }); });
};
export const inventoryWriteTools = { pinterest_create_local_inventory:'CREATE',pinterest_update_local_inventory:'UPDATE',pinterest_upsert_local_inventory:'UPSERT',pinterest_delete_local_inventory:'DELETE' } as const;
export const inventoryBatchReference = z.object({ account_id:pinterestId,batch_receipt:z.string().min(100).max(2_000_000) }).strict();
