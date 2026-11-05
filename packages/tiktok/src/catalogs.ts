import { createHash } from 'node:crypto';
import { AdportError, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import { catalogAccessChange, catalogInput, catalogRename } from './catalog-tools.js';
import { catalogScopeKey, requireCatalogAccess, type TikTokCatalogAccessStore, type TikTokCatalogScope } from './catalog-access.js';
import type { TikTokClient } from './client.js';
import { TikTokCatalogProductSets } from './catalog-product-sets.js';

type Row = Record<string, unknown>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
const id = z.string().regex(/^\d{1,30}$/);
const nativeCatalog = z.looseObject({ catalog_id: id, catalog_name: z.string(), catalog_type: z.string(), bc_info: z.looseObject({ bc_id: id, bc_name: z.string().optional() }), catalog_conf: z.record(z.string(), z.unknown()) });
type Catalog = z.infer<typeof nativeCatalog>;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const config = (value: Catalog) => ({ catalog_id: value.catalog_id, catalog_name: value.catalog_name, catalog_type: value.catalog_type, bc_id: value.bc_info.bc_id, catalog_conf: value.catalog_conf });
const configurationHash = (account: string, value: Catalog) => createHash('sha256').update(canonical({ account_id: account, ...config(value) })).digest('hex');
const scopeOf = (input: { account_id: string; bc_id: string; catalog_id: string }): TikTokCatalogScope => ({ accountId: input.account_id, businessId: input.bc_id, resourceId: input.catalog_id, kind: 'catalog' });
const nativeError = (error: unknown) => {
  const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Row : {};
  return new AdportError('PROVIDER_ERROR', 'TikTok catalog request failed. Check the token’s Business Center/catalog permissions and native API eligibility. No request was retried.', { ...(Number.isInteger(details.code) ? { provider_code: details.code } : {}), ...(typeof details.request_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(details.request_id) ? { request_id: details.request_id } : {}) });
};

/** Account scope and catalog-resource scope are independent authorization checks. */
export class TikTokCatalogService {
  readonly productSets: TikTokCatalogProductSets;
  constructor(private readonly client: Pick<TikTokClient, 'get' | 'post'>, private readonly store?: TikTokCatalogAccessStore) {
    this.productSets = new TikTokCatalogProductSets(client, async (input, write) => {
      await requireCatalogAccess(this.store, scopeOf(input), write);
      return this.native(input);
    });
  }
  private manager() {
    if (!this.store?.canManage) throw new AdportError('POLICY_VIOLATION', 'Only the local owner or a signed-in project owner/admin in Accounts can change catalog access.');
    return this.store;
  }
  private async native(input: z.infer<typeof catalogInput>): Promise<Catalog> {
    let data: unknown;
    try { data = await this.client.get('catalog/get', { bc_id: input.bc_id, catalog_id: input.catalog_id, page: 1, page_size: 1000 }); } catch (error) { if (error instanceof AdportError && ['POLICY_VIOLATION', 'NOT_CONNECTED'].includes(error.code)) throw error;throw nativeError(error); }
    const result = z.looseObject({ list: z.array(nativeCatalog).length(1), page_info: z.looseObject({ page: z.number().int().positive(), total_page: z.number().int().nonnegative() }).optional() }).safeParse(data);
    if (!result.success || result.data.list[0]!.catalog_id !== input.catalog_id || result.data.list[0]!.bc_info.bc_id !== input.bc_id || result.data.page_info && (result.data.page_info.page !== 1 || result.data.page_info.total_page > 1)) throw new AdportError('PROVIDER_ERROR', 'TikTok returned an unexpected catalog/Business Center scope or incomplete exact-ID response.');
    return result.data.list[0]!;
  }
  async access(accountId: string) {
    id.parse(accountId);
    const grants = await this.store?.list(accountId) ?? [];
    if (grants.some(value => value.scope.accountId !== accountId)) throw new AdportError('POLICY_VIOLATION', 'Catalog grants do not match the selected advertiser.');
    return { grants, records: grants.map(value => ({ id: value.scope.resourceId, name: value.scope.kind === 'catalog' ? 'Catalog ' + value.scope.resourceId : 'Catalog creation', business_center_id: value.scope.businessId, access: value.mode })), notes: ['Only explicit project grants are returned. An advertiser account does not implicitly authorize other Business Center assets.'] };
  }
  async accessSnapshot(value: unknown) {
    const input = catalogInput.parse(value), grant = await this.manager().get(scopeOf(input));
    return { grant, records: [{ id: input.catalog_id, name: 'Catalog access', business_center_id: input.bc_id, access: grant.mode }] };
  }
  async get(value: unknown) {
    const input = catalogInput.parse(value);await requireCatalogAccess(this.store, scopeOf(input));
    const catalog = await this.native(input), data = { ...catalog, configuration_hash: configurationHash(input.account_id, catalog) };
    return { catalog: data, records: [{ id: catalog.catalog_id, name: catalog.catalog_name, native_ad_eligibility: catalog.ad_creation_eligible ?? 'Not reported', type: catalog.catalog_type, business_center: catalog.bc_info.bc_name ?? input.bc_id, currency: catalog.catalog_conf.currency ?? 'Not reported', country: catalog.catalog_conf.country ?? 'Not reported' }] };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    if (op.tool === 'tiktok_rename_product_set') return this.productSets.plan(op);
    if (op.provider !== 'tiktok' || op.kind !== 'update') throw new AdportError('INVALID_INPUT', 'TikTok catalog provider/operation kind mismatch.');
    const account = id.parse(op.accountId);
    if (op.tool === 'tiktok_set_catalog_access') {
      const store = this.manager(), input = catalogAccessChange.parse(op.payload), scope = scopeOf({ ...input, account_id: account }), current = await store.get(scope);
      if (current.hash !== input.expected_access_hash) throw new AdportError('POLICY_VIOLATION', 'Catalog access changed. Read and review it again.');
      // Revocation must remain possible after token/catalog access has been lost.
      const catalog = input.mode === 'none' ? undefined : await this.native({ account_id: account, bc_id: input.bc_id, catalog_id: input.catalog_id });
      const title = input.mode === 'none' ? 'Revoke catalog access' : 'Grant catalog access', notes = ['This changes Adport project access, not TikTok’s native user permissions.', 'Write access covers this Business Center catalog wherever it is reused. Agents cannot expand their own hosted access.'];
      return { summary: `${title} · ${catalog?.catalog_name ?? input.catalog_id}`, changes: [`~ Project access ${current.mode} → ${input.mode} for Business Center ${input.bc_id}, catalog ${input.catalog_id}`], coercions: [], budgetDeltas: [], notes,
        review: { provider: 'tiktok', accountId: account, kind: 'update', title, subject: catalog?.catalog_name ?? input.catalog_id, fields: [{ label: 'Business Center', after: catalog?.bc_info.bc_name ?? input.bc_id }, { label: 'Catalog', after: input.catalog_id }, { label: 'Project access', before: current.mode, after: input.mode }], notices: notes },
        execute: async () => { const result = await store.compareAndSet(scope, input.expected_access_hash, input.mode), actual = await store.get(scope);if (catalogScopeKey(result.scope) !== catalogScopeKey(scope) || result.mode !== input.mode || actual.hash !== result.hash) throw new AdportError('POLICY_VIOLATION', 'Catalog access receipt is unconfirmed. Inspect access before retrying.');return [input.catalog_id]; } };
    }
    if (op.tool !== 'tiktok_update_catalog') throw new AdportError('INVALID_INPUT', 'Unsupported TikTok catalog mutation.');
    const input = catalogRename.parse(op.payload), source = { account_id: account, bc_id: input.bc_id, catalog_id: input.catalog_id }, scope = scopeOf(source);
    await requireCatalogAccess(this.store, scope, true);const current = await this.native(source);
    if (configurationHash(account, current) !== input.expected_configuration_hash) throw new AdportError('INVALID_INPUT', 'Catalog configuration changed. Read and preview it again.');
    const notes = ['Local preview only; TikTok checks native permissions and eligibility on apply.', 'The catalog may be reused by other ads or accounts. This operation updates its name and does not activate ads or change a budget.', 'No automatic retry. Inspect the exact catalog after an uncertain result.'];
    return { summary: `Rename TikTok catalog ${current.catalog_name}`, changes: [`~ Catalog name ${JSON.stringify(current.catalog_name)} → ${JSON.stringify(input.name)}`], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'tiktok', accountId: account, kind: 'update', title: 'Rename catalog', subject: current.catalog_name, fields: [{ label: 'Name', before: current.catalog_name, after: input.name }, { label: 'Business Center', after: current.bc_info.bc_name ?? input.bc_id }], notices: notes }, execute: async () => {
        await requireCatalogAccess(this.store, scope, true);
        try {
          const result = z.object({ catalog_id: id }).parse(await this.client.post('catalog/update', { bc_id: input.bc_id, catalog_id: input.catalog_id, name: input.name }));
          if (result.catalog_id !== input.catalog_id) throw new Error('ID differs');
          const actual = await this.native(source);
          if (canonical(config(actual)) !== canonical({ ...config(current), catalog_name: input.name })) throw new Error('Configuration differs');
          return [input.catalog_id];
        } catch {
          throw new AdportError('PROVIDER_ERROR', 'TikTok catalog rename outcome is unconfirmed. Read the known catalog before another write; do not replay automatically.', { resource_ids: [input.catalog_id] });
        }
      } };
  }
}
