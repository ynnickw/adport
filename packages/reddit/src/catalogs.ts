import { createHash } from 'node:crypto';
import { AdportError, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { RedditAdsClient } from './client.js';
import { catalogGrant, catalogScopeKey, creationScope, redditBusinessId, redditCatalogId, requireCatalogAccess, requireCatalogCreationAccess, type RedditCatalogAccessStore, type RedditCatalogScope } from './catalog-access.js';
import { catalogInput, creationContext, sourceContext, catalogCreate, catalogRename, catalogSources, catalogDelete, permissionSnapshot, permissionChange } from './catalog-schemas.js';

type Scope = z.infer<typeof catalogInput>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
const count = z.number().int().nonnegative().safe(), eventSources = z.array(redditCatalogId.max(50)).max(5000).refine(ids => new Set(ids).size === ids.length);
const nativeCatalog = z.object({ id: redditCatalogId, business_id: redditBusinessId, name: z.string().min(1).max(200), default_language: z.string().min(1).max(32), default_currency: z.string().regex(/^[A-Z]{3}$/), event_sources: eventSources.optional(), data_sources: z.array(z.string()).max(100).optional(), summary: z.object({ products_count: count.optional(), approved_products_count: count.optional(), rejected_products_count: count.optional(), invalid_products_count: count.optional() }).optional() });
type Catalog = z.infer<typeof nativeCatalog>;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const config = (row: Catalog) => ({ id: row.id, business_id: row.business_id, name: row.name, default_language: row.default_language, default_currency: row.default_currency, event_sources: row.event_sources ? [...row.event_sources].sort() : undefined });
const configurationHash = (scope: Scope, row: Catalog) => digest({ account_id: scope.account_id, business_id: scope.business_id, catalog_id: scope.catalog_id, configuration: config(row) });
const resource = (input: Scope): RedditCatalogScope => ({ accountId: input.account_id, businessId: input.business_id, resourceId: input.catalog_id, kind: 'catalog' });
const permissionResource = (input: { account_id: string; business_id: string; catalog_id?: string; resource_kind?: string }) => input.resource_kind === 'catalog_creation' ? creationScope(input.account_id, input.business_id) : resource({ ...input, catalog_id: input.catalog_id! });
const failure = (error: unknown, message: string, ids?: string[]) => {
  const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  return new AdportError('PROVIDER_ERROR', message + ' Provider bodies stay hidden; no native write was retried.', { ...(Number.isInteger(details.http_status) ? { http_status: details.http_status } : {}), ...(ids ? { resourceIds: ids } : {}) });
};
const invalid = () => new AdportError('PROVIDER_ERROR', 'Reddit catalog/Business scope or native response shape could not be verified.');

/** Explicit Business-resource permissions are independent from enabled ad-account access. */
export class RedditCatalogService {
  constructor(private readonly client: Pick<RedditAdsClient, 'get' | 'post' | 'patch' | 'delete' | 'getPaged'>, private readonly store?: RedditCatalogAccessStore) {}
  private manager() { if (!this.store?.canManage) throw new AdportError('POLICY_VIOLATION', 'Only the local owner or a signed-in project owner/admin can administer catalog access.');return this.store; }
  private async read(path: string, absent = false) {
    try { return (await this.client.get<unknown>(path)).data; } catch (error) {
      if (error instanceof AdportError && ['POLICY_VIOLATION', 'NOT_CONNECTED'].includes(error.code)) throw error;
      if (absent && error instanceof AdportError && (error.details as Record<string, unknown> | undefined)?.http_status === 404) return undefined;
      throw failure(error, 'Reddit catalog read failed. Check native Business/catalog access.');
    }
  }
  private async native(scope: Scope, absent = false) {
    const value = await this.read(`product_catalogs/${encodeURIComponent(scope.catalog_id)}`, absent);if (value === undefined && absent) return;
    const parsed = nativeCatalog.safeParse(value);if (!parsed.success || parsed.data.id !== scope.catalog_id || parsed.data.business_id !== scope.business_id) throw invalid();return parsed.data;
  }
  private async parent(scope: Scope, write = false) { await requireCatalogAccess(this.store, resource(scope), write);return (await this.native(scope))!; }
  async authorize(value: unknown, write = false) { const input = catalogInput.parse(value), row = await this.parent(input, write);return { ...row, configuration_hash: configurationHash(input, row) }; }
  private async business(id: string) {
    const parsed = z.object({ id: redditBusinessId, name: z.string().max(4000) }).safeParse(await this.read(`businesses/${encodeURIComponent(id)}`));if (!parsed.success || parsed.data.id !== id) throw invalid();return parsed.data;
  }
  private async selectedSources(input: { account_id: string; business_id: string; catalog_id?: string }, ids: string[]) {
    const selected = [...ids].sort();if (selected.length) {
      let raw: unknown[];
      try { raw = await this.client.getPaged<unknown>(`ad_accounts/${encodeURIComponent(input.account_id)}/pixels`, { 'page.size': 1000 }, 5000); } catch (error) { throw failure(error, 'Selected-account Pixel lookup failed.'); }
      const parsed = z.array(z.object({ id: redditCatalogId, ad_account_id: redditCatalogId.optional() })).max(5000).safeParse(raw);
      if (!parsed.success || parsed.data.some(row => row.ad_account_id !== undefined && row.ad_account_id !== input.account_id) || new Set(parsed.data.map(row => row.id)).size !== parsed.data.length) throw invalid();
      if (selected.some(id => !parsed.data.some(row => row.id === id))) throw new AdportError('INVALID_INPUT', 'Every selected event-source Pixel must be available to the selected ad account within the bounded native lookup.');
    }
    return digest({ account_id: input.account_id, business_id: input.business_id, catalog_id: input.catalog_id ?? null, event_sources: selected });
  }
  async access(account: string) { redditCatalogId.parse(account);const grants = await this.store?.list(account) ?? [];if (grants.some(grant => grant.scope.accountId !== account)) throw new AdportError('POLICY_VIOLATION', 'Catalog access does not match this advertiser.');return { grants, records: grants.map(grant => ({ id: grant.scope.resourceId, name: grant.scope.kind === 'catalog_creation' ? 'New catalogs' : 'Catalog ' + grant.scope.resourceId, business_id: grant.scope.businessId, access: grant.mode })), notes: ['Only explicit project grants are listed. Enabled ad-account access does not authorize Business catalogs.'] }; }
  async snapshot(value: unknown) { const input = permissionSnapshot.parse(value), scope = permissionResource(input), grant = await this.manager().get(scope);return { grant, records: [{ id: scope.resourceId, name: 'Catalog access', business_id: scope.businessId, access: grant.mode }] }; }
  async get(value: unknown) {
    const input = catalogInput.parse(value), current = await this.parent(input);return { catalog: { ...current, configuration_hash: configurationHash(input, current) }, records: [{ id: current.id, name: current.name, business_id: current.business_id, currency: current.default_currency, language: current.default_language, products: current.summary?.products_count, event_source_count: current.event_sources?.length }], notes: ['Native counts/fields that are absent stay unavailable. This is configuration, not full product or dependent-ad inventory.'] };
  }
  async creationContext(value: unknown) {
    const input = creationContext.parse(value), grant = await requireCatalogCreationAccess(this.store, creationScope(input.account_id, input.business_id)), business = await this.business(input.business_id), sourcesHash = await this.selectedSources(input, input.event_sources);
    return { expected_creation_access_hash: grant.hash, expected_event_sources_hash: sourcesHash, event_sources: input.event_sources, business, records: [{ id: business.id, name: business.name, access: 'Create and manage verified new catalogs', selected_event_sources: input.event_sources.length }], complete: true, truncated: false, notes: ['Delegation authorizes creation and management of verified new IDs only. Existing Business catalogs are not enumerated or granted.', 'Selected event-source Pixel IDs are checked under the selected ad account; empty selection installs no binding. No events, products, ads or spend are created by this context.'] };
  }
  async sourceContext(value: unknown) {
    const input = sourceContext.parse(value), current = await this.parent(input), sourcesHash = await this.selectedSources(input, input.event_sources);
    if (!current.event_sources) throw new AdportError('PROVIDER_ERROR', 'Current catalog event sources are unavailable. No replacement preview was prepared.');
    return { expected_configuration_hash: configurationHash(input, current), expected_event_sources_hash: sourcesHash, current_event_sources: current.event_sources, event_sources: input.event_sources, records: [{ id: current.id, name: current.name, previous_sources: current.event_sources.length, selected_sources: input.event_sources.length }], complete: true, truncated: false, notes: ['This replaces the entire event-source list. Empty explicitly clears it. Shared matching and existing ads may be affected; no events are sent.'] };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    if (op.provider !== 'reddit') throw new AdportError('INVALID_INPUT', 'Reddit catalog provider differs.');
    if (op.tool === 'reddit_set_catalog_access' && op.kind === 'update') {
      const store = this.manager(), input = permissionChange.parse(op.payload), scope = permissionResource({ ...input, account_id: op.accountId }), before = await store.get(scope);if (before.hash !== input.expected_access_hash) throw new AdportError('PENDING_MISMATCH', 'Catalog access changed. Read and review it again.');
      const creation = scope.kind === 'catalog_creation';let subject = creation ? 'New catalogs' : input.catalog_id!;
      if (input.mode !== 'none') { const business = await this.business(input.business_id);subject = creation ? business.name : (await this.native({ account_id: op.accountId, business_id: input.business_id, catalog_id: input.catalog_id! }))!.name; }
      const notes = ['Changes Adport project access, not Reddit native user permissions. Native Business/catalog eligibility remains authoritative.', 'Creation delegates management of verified new catalog IDs only. Existing catalogs require separate grants. Revoking creation leaves existing catalog grants independent.'];
      return { summary: `${input.mode === 'none' ? 'Revoke' : 'Grant'} Reddit catalog access · ${subject}`, changes: [`~ Project access ${before.mode} → ${input.mode} for Business ${input.business_id}, ${creation ? 'new catalogs only' : 'catalog ' + input.catalog_id}`], coercions: [], budgetDeltas: [], notes,
        review: { provider: 'reddit', accountId: op.accountId, kind: 'update', title: input.mode === 'none' ? 'Revoke catalog access' : creation ? 'Delegate catalog creation' : 'Grant catalog access', subject, fields: [{ label: 'Business', after: input.business_id }, { label: 'Resource', after: creation ? 'Verified new catalogs only' : input.catalog_id }, { label: 'Project access', before: before.mode, after: input.mode === 'create' ? 'Create and manage new catalogs' : input.mode }], notices: notes },
        execute: async () => { const result = await store.compareAndSet(scope, input.expected_access_hash, input.mode), actual = await store.get(scope);if (catalogScopeKey(result.scope) !== catalogScopeKey(scope) || result.mode !== input.mode || actual.hash !== result.hash) throw new AdportError('POLICY_VIOLATION', 'Catalog access receipt could not be confirmed.');return [scope.resourceId]; } };
    }
    if (op.tool === 'reddit_create_catalog' && op.kind === 'create') {
      const input = catalogCreate.parse(op.payload), selection = { account_id: op.accountId, business_id: input.business_id }, store = this.store;if (!store?.adoptCreated) throw new AdportError('NOT_CONNECTED', 'This runtime cannot adopt independently verified new catalogs.');
      const prepare = async () => { await requireCatalogCreationAccess(store, creationScope(op.accountId, input.business_id), true);const context = await this.creationContext({ ...selection, event_sources: input.event_sources });if (context.expected_creation_access_hash !== input.expected_creation_access_hash || context.expected_event_sources_hash !== input.expected_event_sources_hash) throw new AdportError('PENDING_MISMATCH', 'Creation delegation or selected sources changed. Read context and request a new preview.'); };
      await prepare();const data = { name: input.name, default_currency: input.default_currency, default_language: input.default_language, event_sources: input.event_sources }, notes = ['Creates an empty Business catalog. No products, ads, spend or conversion events are submitted.', 'Default currency/language are not patchable through the current catalog endpoint. Project write access is adopted only for this verified new native ID.', 'Native creation and project access are not atomic. Reconcile a known ID after uncertain creation/readback/adoption; never replay automatically.'];
      return { summary: `Create Reddit catalog "${input.name}"`, changes: ['+ Catalog ' + canonical(data), '+ Project read/write access for the verified new ID only'], coercions: [], budgetDeltas: [], notes,
        review: { provider: 'reddit', accountId: op.accountId, kind: 'create', title: 'Create catalog', subject: input.name, fields: [{ label: 'Business', after: input.business_id }, { label: 'Default currency', after: input.default_currency }, { label: 'Default language', after: input.default_language }, { label: 'Event-source Pixels', after: input.event_sources.join(', ') || 'None' }, { label: 'New catalog project access', after: 'Read and write' }], notices: notes },
        execute: async () => { await prepare();let id: string | undefined;try {
          const raw = (await this.client.post<unknown>(`businesses/${encodeURIComponent(input.business_id)}/product_catalogs`, { data })).data, knownId = z.object({ id: redditCatalogId }).safeParse(raw);if (knownId.success) id = knownId.data.id;
          const receipt = nativeCatalog.parse(raw);id = receipt.id;if (receipt.business_id !== input.business_id) throw invalid();
          await requireCatalogCreationAccess(store, creationScope(op.accountId, input.business_id), true);const actual = await this.native({ ...selection, catalog_id: id });if (!actual || canonical(config(actual)) !== canonical({ id, business_id: input.business_id, ...data, event_sources: [...data.event_sources].sort() })) throw new Error('Creation readback differs');
          const adopted = await store.adoptCreated!({ accountId: op.accountId, businessId: input.business_id, resourceId: id, kind: 'catalog' }, input.expected_creation_access_hash);if (adopted.mode !== 'write' || adopted.scope.resourceId !== id || adopted.scope.businessId !== input.business_id || adopted.scope.accountId !== op.accountId || adopted.scope.kind !== 'catalog') throw new Error('Adoption receipt differs');return [id];
        } catch (error) { throw failure(error, 'Reddit catalog creation or project adoption is unconfirmed. Reconcile known IDs before another create.', id ? [id] : undefined); } } };
    }
    const rename = op.tool === 'reddit_rename_catalog', sources = op.tool === 'reddit_set_catalog_event_sources', remove = op.tool === 'reddit_delete_catalog';
    if (!(rename && op.kind === 'update' || sources && op.kind === 'update' || remove && op.kind === 'remove')) throw new AdportError('INVALID_INPUT', 'Unsupported Reddit catalog operation or kind.');
    const input = rename ? catalogRename.parse(op.payload) : sources ? catalogSources.parse(op.payload) : catalogDelete.parse(op.payload), scope: Scope = { account_id: op.accountId, business_id: input.business_id, catalog_id: input.catalog_id };
    const prepare = async () => { const current = await this.parent(scope, true);if (configurationHash(scope, current) !== input.expected_configuration_hash || 'confirm_catalog_name' in input && current.name !== input.confirm_catalog_name) throw new AdportError('PENDING_MISMATCH', 'Catalog configuration/name changed. Read and preview again.');if (!remove && !current.event_sources) throw new AdportError('PROVIDER_ERROR', 'Current event sources are unavailable; preservation cannot be verified.');if ('expected_event_sources_hash' in input && await this.selectedSources(scope, input.event_sources) !== input.expected_event_sources_hash) throw new AdportError('PENDING_MISMATCH', 'Selected event sources changed. Request a fresh preview.');return current; };
    const current = await prepare(), data = 'name' in input ? { name: input.name } : 'event_sources' in input ? { event_sources: input.event_sources } : {}, title = rename ? 'Rename catalog' : sources ? 'Replace catalog event sources' : 'Delete catalog permanently', notes = remove ? ['Permanently removes the entire shared catalog and affects its current contents/consumers. Contents are not enumerated or frozen by this configuration snapshot.', 'Checks native acknowledgement and exact lookup absence. Other errors are not absence; no restore/global usage guarantee or automatic replay. Project grants remain separate owner settings.'] : ['Changes a shared Business catalog; other accounts/ads may be affected. Unselected configuration is checked after the write.', ...(sources ? ['Replaces the entire event-source list, including clearing it when explicitly empty. Selected Pixel IDs are checked under this ad account. No conversion events are sent.'] : []), 'No automatic write replay; reconcile the known catalog after any uncertain result.'];
    return { summary: `${title} "${current.name}"`, changes: [remove ? '- Entire catalog ' + current.id + ' and its current contents' : '~ Catalog configuration ' + canonical(data)], coercions: [], budgetDeltas: [], notes,
      review: { provider: 'reddit', accountId: op.accountId, kind: remove ? 'remove' : 'update', title, subject: current.name, fields: [{ label: 'Catalog', after: current.id }, { label: 'Business', after: current.business_id }, ...(rename ? [{ label: 'Name', before: current.name, after: (input as z.infer<typeof catalogRename>).name }] : sources ? [{ label: 'Event-source Pixels', before: current.event_sources!.join(', ') || 'None', after: (input as z.infer<typeof catalogSources>).event_sources.join(', ') || 'None' }] : [{ label: 'Contents affected', after: 'Entire catalog; contents not enumerated or frozen' }])], notices: notes },
      execute: async () => { const fresh = await prepare();try {
        if (remove) { const receipt = await this.client.delete<unknown>(`product_catalogs/${encodeURIComponent(current.id)}`);if (receipt.data === null || typeof receipt.data !== 'object' || Array.isArray(receipt.data)) throw new Error('Unexpected deletion acknowledgement');await requireCatalogAccess(this.store, resource(scope), true);if (await this.native(scope, true)) throw new Error('Catalog remains visible'); }
        else { const receipt = nativeCatalog.parse((await this.client.patch<unknown>(`product_catalogs/${encodeURIComponent(current.id)}`, { data })).data);if (receipt.id !== current.id || receipt.business_id !== scope.business_id) throw invalid();await requireCatalogAccess(this.store, resource(scope), true);const actual = await this.native(scope), expected = config({ ...fresh, ...data });if (!actual || canonical(config(actual)) !== canonical(expected)) throw new Error('Catalog preservation readback differs'); }
        return [current.id];
      } catch (error) { throw failure(error, 'Reddit catalog mutation or independent preservation/absence readback is unconfirmed. Inspect the known catalog before another write.', [current.id]); } } };
  }
}
