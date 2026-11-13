import { createHash } from 'node:crypto';
import { AdportError, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { TikTokClient } from './client.js';
import { catalogId, catalogInput } from './catalog-schema.js';
import { creationScope, requireCatalogCreationAccess, requireCatalogAccess, type TikTokCatalogAccessStore } from './catalog-access.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/), region = z.string().regex(/^[A-Z]{2}$/), currency = z.string().regex(/^[A-Z]{3}$/);
const types = ['ECOM', 'HOTEL', 'FLIGHT', 'DESTINATION', 'ENTERTAINMENT', 'AUTO_VEHICLE', 'AUTO_MODEL', 'MINI_SERIES', 'GENERIC', 'ONLINE_TO_OFFLINE'] as const;
export const catalogCreationInput = z.object({ account_id: catalogId, bc_id: catalogId }).strict();
const conf = z.object({ currency, region_code: region.optional(), is_multi_country: z.boolean().optional(), channel: z.enum(['PARTNER', 'CLIENT']).optional(), additional_config_list: z.array(z.object({ region_code: region, currency }).strict()).min(1).max(100).optional() }).strict();
export const catalogCreate = z.object({ bc_id: catalogId, name: z.string().trim().min(1).max(128), catalog_type: z.enum(types), catalog_conf: conf, expected_creation_access_hash: hash, expected_regions_hash: hash, acknowledge_new_catalog_management: z.literal(true) }).strict().superRefine((input, ctx) => {
  const c = input.catalog_conf;
  if (['ECOM', 'HOTEL', 'FLIGHT', 'DESTINATION'].includes(input.catalog_type) && c.is_multi_country === undefined) ctx.addIssue({ code: 'custom', path: ['catalog_conf', 'is_multi_country'], message: 'Adport requires an explicit immutable is_multi_country choice for this catalog type' });
  if (c.is_multi_country !== undefined && !['ECOM', 'HOTEL', 'FLIGHT', 'DESTINATION'].includes(input.catalog_type)) ctx.addIssue({ code: 'custom', path: ['catalog_conf', 'is_multi_country'], message: 'is_multi_country is documented only for ECOM/HOTEL/FLIGHT/DESTINATION' });
  if (c.is_multi_country ? c.region_code !== undefined : !c.region_code) ctx.addIssue({ code: 'custom', path: ['catalog_conf', 'region_code'], message: 'Choose a primary region for single-country catalogs; omit it for multi-country catalogs' });
  if (c.additional_config_list && (input.catalog_type !== 'MINI_SERIES' || new Set([c.region_code, ...c.additional_config_list.map(row => row.region_code)]).size !== c.additional_config_list.length + 1)) ctx.addIssue({ code: 'custom', path: ['catalog_conf', 'additional_config_list'], message: 'Additional regions are for MINI_SERIES only and cannot duplicate each other or the primary region' });
});
export const catalogDelete = catalogInput.omit({ account_id: true }).extend({ expected_configuration_hash: hash, confirm_catalog_name: z.string().min(1).max(128), acknowledge_shared_effects: z.literal(true), acknowledge_delete_products_and_feeds: z.literal(true) }).strict();
type Scope = z.infer<typeof catalogInput>;
type Catalog = { catalog_id: string; catalog_name: string; catalog_type: string; catalog_conf: Record<string, unknown>; bc_info: { bc_id: string; bc_name?: string } };
type Parent = Catalog & { configuration_hash: string };
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const additional = (value: unknown) => canonical(z.array(z.object({ region_code: region, currency }).strict()).parse(value).sort((a, b) => a.region_code.localeCompare(b.region_code)));
const failure = (error: unknown, message: string, ids?: string[]) => {
  const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  return new AdportError('PROVIDER_ERROR', message + ' Native bodies stay hidden; no write was retried.', { ...(Number.isSafeInteger(details.code) ? { provider_code: details.code } : {}), ...(typeof details.request_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(details.request_id) ? { request_id: details.request_id } : {}), ...(ids ? { resourceIds: ids } : {}) });
};

/** Create delegation covers only exact new receipts, never existing Business Center catalogs. */
export class TikTokCatalogLifecycle {
  constructor(private readonly client: Pick<TikTokClient, 'get' | 'post'>, private readonly store: TikTokCatalogAccessStore | undefined, private readonly parent: (scope: Scope, write?: boolean) => Promise<Parent>, private readonly lookup: (scope: Scope) => Promise<Catalog | undefined>) {}
  async availableCountries(bcId: string) {
    catalogId.parse(bcId);let raw;
    try { raw = await this.client.get('catalog/available_country/get', { bc_id: bcId }); } catch (error) { throw failure(error, 'Native catalog-region lookup failed. Check the exact Business Center and token.'); }
    const parsed = z.object({ region_codes: z.array(region).max(500), bc_id: catalogId.optional() }).safeParse(raw);
    if (!parsed.success || parsed.data.bc_id !== undefined && parsed.data.bc_id !== bcId || new Set(parsed.data.region_codes).size !== parsed.data.region_codes.length) throw new AdportError('PROVIDER_ERROR', 'Catalog region response scope or shape could not be verified.');
    return parsed.data.region_codes.sort();
  }
  async context(value: unknown) {
    const input = catalogCreationInput.parse(value), grant = await requireCatalogCreationAccess(this.store, creationScope(input.account_id, input.bc_id)), regions = await this.availableCountries(input.bc_id);
    return { expected_creation_access_hash: grant.hash, expected_regions_hash: digest({ ...input, regions }), available_region_codes: regions, catalog_types: [...types], records: [{ id: input.bc_id, name: 'Catalog creation', business_center_id: input.bc_id, access: 'Create and manage new catalogs', available_region_count: regions.length }], complete: true, truncated: false,
      notes: ['Owner delegation covers creation in this exact Business Center and management of successfully verified new catalog IDs. It grants no access to existing catalogs.', 'Region discovery does not certify catalog-type/currency combinations or native creation eligibility. Entertainment, mini-series and some multi-country types need native allowlisting.', 'Catalog type, region, currency, channel and additional regions are immutable configuration. Creation adds no products, ads, spend or events.'] };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    if (op.provider !== 'tiktok') throw new AdportError('INVALID_INPUT', 'Catalog lifecycle provider differs.');
    if (op.tool === 'tiktok_create_catalog' && op.kind === 'create') {
      const input = catalogCreate.parse(op.payload), selection = { account_id: op.accountId, bc_id: input.bc_id }, store = this.store;
      if (!store?.adoptCreated) throw new AdportError('NOT_CONNECTED', 'This runtime cannot adopt independently verified new catalogs. No native create was submitted.');
      const prepare = async () => {
        await requireCatalogCreationAccess(store, creationScope(op.accountId, input.bc_id), true);const current = await this.context(selection);
        if (current.expected_creation_access_hash !== input.expected_creation_access_hash || current.expected_regions_hash !== input.expected_regions_hash) throw new AdportError('PENDING_MISMATCH', 'Creation delegation or available regions changed. Read context and request a new preview.');
        const requested = [input.catalog_conf.region_code, ...input.catalog_conf.additional_config_list?.map(row => row.region_code) ?? []].filter((code): code is string => !!code);
        if (requested.some(code => !current.available_region_codes.includes(code))) throw new AdportError('INVALID_INPUT', 'A selected region is not available in this Business Center.');
      };
      await prepare();const c = input.catalog_conf, notes = ['Local preview only. Native creation eligibility, allowlists and supported type/currency/region combinations are checked on apply.', 'Creates an empty Business Center catalog. No products, ads, budgets, tracking or events are created.', 'The owner delegated read/write management of this successfully created, independently verified catalog ID only. Existing catalogs are not adopted or enumerated.', 'Type, region, currency, channel and additional targeting configuration cannot be edited later. Uncertain creation or access adoption retains known IDs; reconcile before another create.'];
      return { summary: `Create TikTok catalog "${input.name}"`, changes: [`+ ${input.catalog_type} catalog ${input.name} in Business Center ${input.bc_id}`, `+ Immutable catalog configuration ${canonical(c)}`, '+ Project read/write grant for the independently verified new catalog ID only'], coercions: [], budgetDeltas: [], notes,
        review: { provider: 'tiktok', accountId: op.accountId, kind: 'create', title: 'Create catalog', subject: input.name, fields: [{ label: 'Business Center', after: input.bc_id }, { label: 'Catalog type', after: input.catalog_type }, { label: 'Primary region', after: c.region_code ?? 'Multi-country' }, { label: 'Currency', after: c.currency }, { label: 'Multi-country', after: c.is_multi_country ?? false }, { label: 'Channel', after: c.channel ?? 'Native default' }, { label: 'Additional regions', after: c.additional_config_list?.map(row => row.region_code + ':' + row.currency).join(', ') || 'None' }, { label: 'New catalog project access', after: 'Read and write' }], notices: notes },
        execute: async () => {
          await prepare();let id: string | undefined;
          try {
            const receipt = z.object({ catalog_id: catalogId }).parse(await this.client.post('catalog/create', { bc_id: input.bc_id, name: input.name, catalog_type: input.catalog_type, catalog_conf: c }));id = receipt.catalog_id;
            await requireCatalogCreationAccess(store, creationScope(op.accountId, input.bc_id), true);const scope: Scope = { ...selection, catalog_id: id }, actual = await this.lookup(scope);
            if (!actual || actual.catalog_name !== input.name || actual.catalog_type !== input.catalog_type || actual.catalog_conf.currency !== c.currency || c.region_code !== undefined && actual.catalog_conf.country !== c.region_code || c.is_multi_country !== undefined && actual.catalog_conf.is_multi_country !== c.is_multi_country || c.channel !== undefined && actual.catalog_conf.channel !== c.channel || c.additional_config_list !== undefined && additional(actual.catalog_conf.additional_config_list) !== additional(c.additional_config_list)) throw new Error('Created catalog configuration differs');
            const adopted = await store.adoptCreated!({ accountId: op.accountId, businessId: input.bc_id, resourceId: id, kind: 'catalog' }, input.expected_creation_access_hash);
            if (adopted.scope.accountId !== op.accountId || adopted.scope.businessId !== input.bc_id || adopted.scope.resourceId !== id || adopted.scope.kind !== 'catalog' || adopted.mode !== 'write') throw new Error('Adoption receipt differs');return [id];
          } catch (error) { throw failure(error, 'Catalog creation, configuration readback or project adoption is unconfirmed. Reconcile the known catalog before another create.', id ? [id] : undefined); }
        } };
    }
    if (op.tool === 'tiktok_delete_catalog' && op.kind === 'remove') {
      const input = catalogDelete.parse(op.payload), scope: Scope = { account_id: op.accountId, bc_id: input.bc_id, catalog_id: input.catalog_id };
      const prepare = async () => { const current = await this.parent(scope, true);if (current.configuration_hash !== input.expected_configuration_hash || current.catalog_name !== input.confirm_catalog_name) throw new AdportError('PENDING_MISMATCH', 'Catalog configuration/name changed. Read it and request a fresh deletion preview.');return current; };
      const current = await prepare(), notes = ['Permanently deletes the entire shared catalog, including its current products and feeds. Existing ads or other accounts may be affected. No restore endpoint or global/atomic usage guarantee is available.', 'Dependent contents are not enumerated or frozen by this configuration snapshot. Deletion applies to the entire catalog and its contents at apply time.', 'Native deletion receipt and filtered catalog absence are checked independently. Provider errors are not absence; uncertain results are never replayed.', 'Adport access grants remain separate owner settings; revocation is available without native catalog access.'];
      return { summary: `Permanently delete TikTok catalog "${current.catalog_name}"`, changes: [`- Entire catalog ${input.catalog_id} and its current products/feeds`, '- Catalog availability to existing shared consumers'], coercions: [], budgetDeltas: [], notes,
        review: { provider: 'tiktok', accountId: op.accountId, kind: 'remove', title: 'Delete catalog permanently', subject: current.catalog_name, fields: [{ label: 'Catalog', after: input.catalog_id }, { label: 'Business Center', after: input.bc_id }, { label: 'Catalog type', after: current.catalog_type }, { label: 'Contents affected', after: 'All current products and feeds; not enumerated or frozen' }], notices: notes },
        execute: async () => { await prepare();try {
          const receipt = z.object({ catalog_id: catalogId }).parse(await this.client.post('catalog/delete', { bc_id: input.bc_id, catalog_id: input.catalog_id }));if (receipt.catalog_id !== input.catalog_id) throw new Error('Deletion receipt differs');
          await requireCatalogAccess(this.store, { accountId: op.accountId, businessId: input.bc_id, resourceId: input.catalog_id, kind: 'catalog' }, true);if (await this.lookup(scope)) throw new Error('Catalog remains visible');return [input.catalog_id];
        } catch (error) { throw failure(error, 'Catalog deletion or filtered-view absence is unconfirmed. Inspect the known catalog before another deletion.', [input.catalog_id]); } } };
    }
    throw new AdportError('INVALID_INPUT', 'Unsupported catalog lifecycle operation or kind.');
  }
}
