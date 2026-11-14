import { createHash } from 'node:crypto';
import { AdportError, creativesOutput, defineTool, guardedWriteTool, type AnyToolDefinition, type Creative, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { PinterestAdsClient } from './client.js';
import type { PinterestAdsProvider } from './provider.js';
import { pinterestId as id } from './schemas.js';

type Row = Record<string, unknown>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute: () => Promise<string[]> };
const hash = z.string().regex(/^[a-f0-9]{64}$/), name = z.string().trim().min(1).max(255), description = z.string().max(1000).nullable();
const ids = z.array(id).min(1).max(100).refine(v => new Set(v).size === v.length, 'Use unique IDs');
const href = z.string().url().max(2048).refine(value => { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }, 'Use an HTTP(S) URL without credentials');
const domain = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/);
const customer = z.object({ audience_type: z.literal('CUSTOMER_LIST'), customer_list_id: id, expected_source_hash: hash }).strict();
const visitor = z.object({ audience_type: z.literal('VISITOR'), visitor_source_ids: ids, retention_days: z.number().int().min(1).max(540), prefill: z.boolean(), event: z.string().min(1).max(100).optional(), event_source: z.array(z.enum(['web', 'mobile', 'offline'])).min(1).max(3).optional(), ingestion_source: z.array(z.enum(['tag', 'mmp', 'file_upload', 'conversions_api'])).min(1).max(4).optional(), url: z.array(href).min(1).max(100).optional() }).strict();
const engagement = z.object({ audience_type: z.literal('ENGAGEMENT'), engagement_domains: z.array(domain).min(1).max(10), engagement_type: z.enum(['click', 'save', 'closeup', 'comment', 'like']).optional(), engager_type: z.number().int().min(1).max(2).optional(), retention_days: z.number().int().min(1).max(540).optional(), campaign_ids: ids.optional(), ad_ids: ids.optional(), pin_ids: z.array(z.string().regex(/^\d{1,30}$/)).min(1).max(100).optional(), objective_types: z.array(z.enum(['AWARENESS', 'CONSIDERATION', 'WEB_CONVERSION', 'CATALOG_SALES', 'VIDEO_COMPLETION', 'SALES'])).min(1).max(6).optional(), url: z.array(href).min(1).max(100).optional() }).strict();
const actalike = z.object({ audience_type: z.literal('ACTALIKE'), seeds: z.array(z.object({ audience_id: id, expected_snapshot_hash: hash }).strict()).min(1).max(100).refine(v => new Set(v.map(s => s.audience_id)).size === v.length, 'Use unique seeds'), country: z.enum(['US', 'CA', 'GB']), percentage: z.number().int().min(1).max(10) }).strict();
const definition = z.discriminatedUnion('audience_type', [customer, visitor, engagement, actalike]);
type Definition = z.infer<typeof definition>;
const audience = z.looseObject({ id, ad_account_id: id.optional(), name: z.string().optional(), description: z.string().nullable().optional(), audience_type: z.string().optional(), rule: z.record(z.string(), z.unknown()).optional(), is_nca: z.boolean().optional(), status: z.string().optional() });
const customerList = z.object({ id, name: z.string(), ad_account_id: id.optional(), is_nca: z.boolean().optional(), status: z.string().optional(), created_time: z.number().finite().optional(), updated_time: z.number().finite().optional(), num_batches: z.number().int().nonnegative().optional(), num_uploaded_user_records: z.number().int().nonnegative().optional(), num_removed_user_records: z.number().int().nonnegative().optional(), exceptions: z.record(z.string(), z.unknown()).optional() });
const selected = { audience_id: id, expected_snapshot_hash: hash };
const createAudience = z.object({ name, description: description.optional(), definition }).strict();
const updateAudience = z.object({ ...selected, name: name.optional(), description: description.optional() }).strict().refine(v => v.name !== undefined || v.description !== undefined, 'Supply audience copy');
const replaceRule = z.object({ ...selected, expected_context_hash: hash, definition }).strict();
const removeAudience = z.object({ audience_id: id, expected_context_hash: hash, confirm_permanent_removal: z.literal(true) }).strict();
const records = z.array(hash).min(1).max(10_000).refine(v => new Set(v).size === v.length, 'Use unique SHA-256 records');
const createList = z.object({ name, list_type: z.enum(['EMAIL', 'IDFA', 'MAID']).default('EMAIL'), is_nca: z.boolean().default(false), records_sha256: records, confirm_data_rights: z.literal(true) }).strict();
const updateRecords = z.object({ customer_list_id: id, expected_snapshot_hash: hash, operation_type: z.enum(['ADD', 'REMOVE']), records_sha256: records, confirm_data_rights: z.literal(true) }).strict();
const writes = new Map<string, WriteOperation['kind']>([['pinterest_create_audience', 'create'], ['pinterest_update_audience', 'update'], ['pinterest_replace_audience_rule', 'update'], ['pinterest_remove_audience', 'remove'], ['pinterest_create_customer_list', 'create'], ['pinterest_update_customer_list_records', 'update']]);
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
function canonical(value: unknown): unknown {
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new AdportError('PROVIDER_ERROR', 'pinterest: unsafe native identifier or counter in audience configuration');
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const audienceSnapshot = (value: z.infer<typeof audience>) => digest(Object.fromEntries(['id', 'ad_account_id', 'name', 'description', 'audience_type', 'rule', 'is_nca'].map(key => [key, value[key] ?? null])));
const listSnapshot = (value: z.infer<typeof customerList>) => digest(Object.fromEntries((['id', 'ad_account_id', 'name', 'is_nca', 'updated_time', 'num_batches', 'num_uploaded_user_records', 'num_removed_user_records'] as const).map(key => [key, value[key] ?? null])));
function normalizeRule(value: unknown): Row {
  const rule = { ...object(value) };
  if (rule.percentage !== undefined) rule.percentage = String(rule.percentage);
  if (typeof rule.visitor_source_id === 'string') rule.visitor_source_id = [rule.visitor_source_id];
  if (Array.isArray(rule.seed_id)) { canonical(rule.seed_id); rule.seed_id = rule.seed_id.map(String); }
  return rule;
}
function includesFields(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => includesFields(actual[index], value));
  if (expected !== null && typeof expected === 'object') return Object.entries(object(expected)).every(([key, value]) => includesFields(object(actual)[key], value));
  return actual === expected;
}

/** Pinterest-owned v5 OpenAPI5.28.0 audience/customer-list contracts, fetched2026-11-04. */
export class PinterestAudienceService {
  constructor(private readonly client: PinterestAdsClient, private readonly entity: (account: string, type: 'campaigns' | 'ads', resource: string) => Promise<Row>, private readonly pin: (account: string, resource: string) => Promise<{ pin: Row }>) {}
  supports(tool: string) { return writes.has(tool); }
  private base(account: string) { return `ad_accounts/${id.parse(account)}`; }
  private async page<T>(account: string, path: string, schema: z.ZodType<T>, size: number, bookmark?: string, extra: Record<string, string> = {}) {
    const data = await this.client.get(`${this.base(account)}/${path}`, z.object({ items: z.array(schema), bookmark: z.string().nullable().optional() }), new URLSearchParams({ ...extra, page_size: String(size), ...(bookmark ? { bookmark } : {}) }));
    if (data.items.length > size || data.bookmark && (!data.items.length || data.bookmark === bookmark)) throw new AdportError('PROVIDER_ERROR', 'pinterest: audience pagination did not advance or exceeded page size');
    return { ...data, truncated: Boolean(data.bookmark), ...(data.bookmark ? { next_cursor: data.bookmark } : {}) };
  }
  async list(input: { account_id: string; ownership_type: 'OWNED' | 'RECEIVED'; page_size: number; bookmark?: string }) {
    const data = await this.page(input.account_id, 'audiences', audience, input.page_size, input.bookmark, { ownership_type: input.ownership_type });
    if (new Set(data.items.map(v => v.id)).size !== data.items.length || input.ownership_type === 'OWNED' && data.items.some(v => v.ad_account_id !== undefined && v.ad_account_id !== input.account_id)) throw new AdportError('PROVIDER_ERROR', 'pinterest: owned audience list returned foreign ownership or duplicate IDs');
    return { ...data, items: data.items.map(v => ({ ...v, owned_by_advertiser: v.ad_account_id === input.account_id, snapshot_hash: audienceSnapshot(v) })) };
  }
  async get(account: string, audienceId: string) {
    const current = await this.client.get(`${this.base(account)}/audiences/${id.parse(audienceId)}`, audience);
    if (current.id !== audienceId || current.ad_account_id !== account) throw new AdportError('INVALID_INPUT', 'pinterest: audience ownership was not confirmed for this advertiser; received audiences are not writable');
    const snapshotHash = audienceSnapshot(current);
    const creative: Creative = { id: current.id, provider: 'pinterest', account_id: account, name: current.name ?? current.id, type: `${current.audience_type ?? 'UNKNOWN'}_AUDIENCE`, ...(current.status ? { status: current.status } : {}), headlines: [], descriptions: current.description ? [current.description] : [], landing_urls: [], media: [], actions: [{ label: 'Edit audience', tool: 'pinterest_update_audience', arguments: { account_id: account, audience_id: current.id, expected_snapshot_hash: snapshotHash }, fields: [{ key: 'name', label: 'Audience name', type: 'text', value: current.name ?? '', max_length: 255 }, { key: 'description', label: 'Description', type: 'text', value: current.description ?? '', max_length: 1000 }] }] };
    return { audience: current, snapshot_hash: snapshotHash, creatives: [creative], truncated: false, notes: ['Processing status/size can change independently. Audiences have no pause flag; these are not ad-delivery statuses.', 'The copy/configuration hash is current state, not a native monotonic version or atomic conditional-write token.'] };
  }
  async getCustomerList(account: string, resource: string) {
    const current = await this.client.get(`${this.base(account)}/customer_lists/${id.parse(resource)}`, customerList);
    if (current.id !== resource || current.ad_account_id !== account) throw new AdportError('INVALID_INPUT', 'pinterest: customer list is not explicitly owned by this advertiser');
    const { exceptions: _exceptions, ...metadata } = current;
    return { customer_list: metadata, snapshot_hash: listSnapshot(current), has_exceptions: Boolean(current.exceptions && Object.keys(object(current.exceptions)).length), notes: ['Native processing and matching are asynchronous. Acceptance is not proof of matched users or serving eligibility.', 'Customer identifiers and exception contents are not returned. Pinterest has no documented customer-list container delete endpoint here.'] };
  }
  async customerLists(input: { account_id: string; page_size: number; bookmark?: string }) {
    const data = await this.page(input.account_id, 'customer_lists', customerList, input.page_size, input.bookmark);
    if (data.items.some(v => v.ad_account_id !== input.account_id) || new Set(data.items.map(v => v.id)).size !== data.items.length) throw new AdportError('PROVIDER_ERROR', 'pinterest: customer list returned foreign/missing ownership or duplicate IDs');
    return { ...data, items: data.items.map(value => { const { exceptions: _exceptions, ...metadata } = value; return { ...metadata, snapshot_hash: listSnapshot(value) }; }) };
  }
  async sources(account: string) {
    const current = await this.client.get(this.base(account), z.object({ id, owner: z.object({ username: z.string() }) }));
    if (current.id !== account) throw new AdportError('PROVIDER_ERROR', 'pinterest: audience account ID mismatch');
    const native = await this.client.get('user_account', z.object({ username: z.string() }));
    if (native.username.toLowerCase() !== current.owner.username.toLowerCase()) return { token_owner_matches: false, websites: [], complete: false, notes: ['Website discovery is credential-global and cannot establish a delegated advertiser’s domains. Account-scoped tag/list/seed workflows remain available.'] };
    const websites: Array<{ website: string; status?: string; verified_at?: string }> = [], seen = new Set<string>();
    let bookmark: string | undefined;
    for (let page = 0; page < 20; page++) {
      const data = await this.client.get('user_account/websites', z.object({ items: z.array(z.object({ website: z.string(), status: z.string().optional(), verified_at: z.string().optional() })), bookmark: z.string().nullable().optional() }), new URLSearchParams({ page_size: '250', ...(bookmark ? { bookmark } : {}) }));
      if (data.items.length > 250 || data.bookmark && (!data.items.length || seen.has(data.bookmark) || data.bookmark === bookmark)) throw new AdportError('PROVIDER_ERROR', 'pinterest: website pagination did not advance');
      websites.push(...data.items);
      if (!data.bookmark) return { token_owner_matches: true, websites, complete: true, notes: ['Websites belong to the token user, whose owner matches the advertiser. Native statuses are preserved; listing alone does not certify engagement-audience eligibility. No website verification or claim is performed.'] };
      seen.add(data.bookmark); bookmark = data.bookmark;
    }
    return { token_owner_matches: true, websites, complete: false, notes: ['Website inventory exceeded 5,000 entries; engagement-domain validation is blocked.'] };
  }
  private async rule(account: string, value: Definition): Promise<Row> {
    if (value.audience_type === 'CUSTOMER_LIST') {
      const source = await this.getCustomerList(account, value.customer_list_id);
      if (source.snapshot_hash !== value.expected_source_hash) throw new AdportError('PENDING_MISMATCH', 'pinterest: customer-list source changed; read it again');
      return { customer_list_id: value.customer_list_id };
    }
    if (value.audience_type === 'ACTALIKE') {
      for (const seed of value.seeds) {
        const source = await this.get(account, seed.audience_id);
        if (source.snapshot_hash !== seed.expected_snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'pinterest: seed audience configuration changed; read it again');
      }
      return { seed_id: value.seeds.map(v => v.audience_id), country: value.country, percentage: value.percentage };
    }
    if (value.audience_type === 'VISITOR') {
      for (const source of value.visitor_source_ids) {
        const tag = await this.client.get(`${this.base(account)}/conversion_tags/${source}`, z.object({ id, ad_account_id: id }));
        if (tag.id !== source || tag.ad_account_id !== account) throw new AdportError('INVALID_INPUT', 'pinterest: visitor source tag is not owned by this advertiser');
      }
      return { visitor_source_id: value.visitor_source_ids, retention_days: value.retention_days, prefill: value.prefill, ...(value.event ? { event: value.event } : {}), ...(value.event_source ? { event_source: { '=': value.event_source } } : {}), ...(value.ingestion_source ? { ingestion_source: { '=': value.ingestion_source } } : {}), ...(value.url ? { url: value.url } : {}) };
    }
    const available = await this.sources(account);
    const hosts = new Set(available.websites.flatMap(v => { try { return [new URL(v.website.includes('://') ? v.website : `https://${v.website}`).hostname]; } catch { return []; } }));
    if (!available.complete || !available.token_owner_matches || value.engagement_domains.some(v => !hosts.has(v))) throw new AdportError('INVALID_INPUT', 'pinterest: engagement domains are not present in the complete advertiser-owner website inventory');
    for (const campaign of value.campaign_ids ?? []) await this.entity(account, 'campaigns', campaign);
    for (const ad of value.ad_ids ?? []) await this.entity(account, 'ads', ad);
    for (const pin of value.pin_ids ?? []) if ((await this.pin(account, pin)).pin.is_owner !== true) throw new AdportError('INVALID_INPUT', 'pinterest: engagement Pin is not explicitly owned');
    return { engagement_domain: value.engagement_domains, ...(value.engagement_type ? { engagement_type: value.engagement_type } : {}), ...(value.engager_type ? { engager_type: value.engager_type } : {}), ...(value.retention_days ? { retention_days: value.retention_days } : {}), ...(value.campaign_ids ? { campaign_id: value.campaign_ids } : {}), ...(value.ad_ids ? { ad_id: value.ad_ids } : {}), ...(value.pin_ids ? { pin_id: value.pin_ids } : {}), ...(value.objective_types ? { objective_type: value.objective_types } : {}), ...(value.url ? { url: value.url } : {}) };
  }
  private async inventory<T>(account: string, path: string, schema: z.ZodType<T>, extra: Record<string, string> = {}) {
    const items: T[] = [], cursors = new Set<string>(); let bookmark: string | undefined;
    for (let page = 0; page < 50; page++) {
      const data = await this.page(account, path, schema, 100, bookmark, extra); items.push(...data.items);
      if (!data.next_cursor) return { items, complete: true };
      if (cursors.has(data.next_cursor)) throw new AdportError('PROVIDER_ERROR', 'pinterest: usage inventory repeated a cursor');
      cursors.add(data.next_cursor); bookmark = data.next_cursor;
    }
    return { items, complete: false };
  }
  async usage(account: string, resource: string) {
    const current = await this.get(account, resource);
    const groups = await this.inventory(account, 'ad_groups', z.looseObject({ id, ad_account_id: id.optional(), status: z.string().optional(), targeting_spec: z.record(z.string(), z.unknown()).optional() }), { entity_statuses: 'ACTIVE,PAUSED,ARCHIVED,DRAFT,DELETED_DRAFT' });
    const audiences = await this.inventory(account, 'audiences', audience, { ownership_type: 'OWNED' });
    const sharing = [];
    for (const type of ['AD_ACCOUNT', 'BUSINESS_ACCOUNT']) {
      const data = await this.inventory(account, 'audiences/shared/accounts', z.object({ account_id: id, account_type: z.enum(['AD_ACCOUNT', 'BUSINESS_ACCOUNT']) }), { audience_id: resource, account_type: type });
      if (data.items.some(v => v.account_type !== type) || new Set(data.items.map(v => v.account_id)).size !== data.items.length) throw new AdportError('PROVIDER_ERROR', 'pinterest: sharing returned the wrong account type or repeated accounts');
      sharing.push(data);
    }
    const seen = new Set<string>(), references: Array<{ kind: string; id: string; status?: string; targeting_dimensions?: string[]; snapshot_hash?: string }> = [];
    let configurationComplete = true;
    for (const group of groups.items) {
      if (seen.has(group.id) || group.ad_account_id !== undefined && group.ad_account_id !== account) throw new AdportError('PROVIDER_ERROR', 'pinterest: usage returned a foreign or repeated ad group'); seen.add(group.id);
      if (!group.targeting_spec) configurationComplete = false;
      const targeting = group.targeting_spec ?? {};
      for (const key of ['AUDIENCE_INCLUDE', 'AUDIENCE_EXCLUDE']) if (targeting[key] !== undefined && !z.array(id).safeParse(targeting[key]).success) throw new AdportError('PROVIDER_ERROR', 'pinterest: audience targeting references could not be inspected');
      const dimensions = ['AUDIENCE_INCLUDE', 'AUDIENCE_EXCLUDE'].filter(key => Array.isArray(targeting[key]) && (targeting[key] as string[]).includes(resource));
      if (dimensions.length) references.push({ kind: 'ad_group', id: group.id, ...(typeof group.status === 'string' ? { status: group.status } : {}), targeting_dimensions: dimensions });
    }
    seen.clear();
    for (const source of audiences.items) {
      if (seen.has(source.id) || source.ad_account_id !== account) throw new AdportError('PROVIDER_ERROR', 'pinterest: usage returned a foreign or repeated owned audience'); seen.add(source.id);
      const seed = source.rule?.seed_id; canonical(seed);
      if (!['CUSTOMER_LIST', 'VISITOR', 'ENGAGEMENT', 'ACTALIKE'].includes(source.audience_type ?? '') || source.audience_type === 'ACTALIKE' && !Array.isArray(seed)) configurationComplete = false;
      if (source.id !== resource && Array.isArray(seed) && seed.some(v => String(v) === resource)) references.push({ kind: 'derived_audience', id: source.id, snapshot_hash: audienceSnapshot(source) });
    }
    const shared_accounts = sharing.flatMap(v => v.items).filter(v => v.account_type !== 'AD_ACCOUNT' || v.account_id !== account), scan_complete = configurationComplete && groups.complete && audiences.complete && sharing.every(v => v.complete);
    references.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)); shared_accounts.sort((a, b) => `${a.account_type}:${a.account_id}`.localeCompare(`${b.account_type}:${b.account_id}`));
    const context = { snapshot_hash: current.snapshot_hash, references, shared_accounts, scan_complete };
    return { ...current, ...context, context_hash: digest(context), notes: ['Usage covers visible account ad groups, owned derived audiences and both native advertiser/business sharing edges, bounded to5,000 items per inventory.', 'Pinterest has no documented atomic freeze or conditional-write version. Usage is re-read on apply; concurrent native changes remain possible.'] };
  }
  private planWrite(summary: string, changes: string[], execute: Plan['execute'], fieldChanges?: WritePreview['fieldChanges']): Plan {
    return { summary, changes, coercions: [], budgetDeltas: [], ...(fieldChanges ? { fieldChanges } : {}), notes: ['Local preview only; Pinterest has no server dry-run for these audience writes.', 'Native source eligibility, processing and minimum matching sizes remain authoritative. No ad attachment, budget, delivery, tracking installation or event submission is performed.'], execute };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    if (op.provider !== 'pinterest' || writes.get(op.tool) !== op.kind) throw new AdportError('INVALID_INPUT', 'pinterest: invalid audience operation');
    const account = id.parse(op.accountId);
    if (op.tool === 'pinterest_create_customer_list' || op.tool === 'pinterest_update_customer_list_records') {
      const create = op.tool === 'pinterest_create_customer_list', input = create ? createList.parse(op.payload) : updateRecords.parse(op.payload);
      let resource: string | undefined;
      if ('customer_list_id' in input) { resource = input.customer_list_id; const current = await this.getCustomerList(account, resource); if (current.snapshot_hash !== input.expected_snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'pinterest: customer-list batches or metadata changed; read it again'); }
      const recordsDigest = digest(input.records_sha256), body = create ? { name: createList.parse(input).name, list_type: createList.parse(input).list_type, is_nca: createList.parse(input).is_nca, records: input.records_sha256.join(',') } : { operation_type: updateRecords.parse(input).operation_type, records: input.records_sha256.join(',') };
      return this.planWrite(`${create ? 'Create' : 'Update'} Pinterest customer list`, [`${input.records_sha256.length} unique SHA-256 identifiers; batch digest ${recordsDigest}. Identifiers are not included in this preview.`, create ? `New ${createList.parse(input).list_type} list “${createList.parse(input).name}”; expanded matching is_nca=${createList.parse(input).is_nca}.` : `${updateRecords.parse(input).operation_type} membership records on ${resource}.`, 'Native processing is asynchronous. This does not confirm matched users; read customer-list status.'], async () => {
        let result: z.infer<typeof customerList>;
        try { result = await this.client.mutate(`${this.base(account)}/customer_lists${resource ? `/${resource}` : ''}`, create ? 'POST' : 'PATCH', body, customerList); }
        catch (error) {
          const details = error instanceof AdportError ? object(error.details) : {}, ids = Array.isArray(details.resource_ids) ? details.resource_ids.filter(v => id.safeParse(v).success) : resource ? [resource] : [];
          throw new AdportError('PROVIDER_ERROR', 'pinterest: customer-list write was not confirmed; reconcile before retrying. Identifiers/native error text are withheld.', { ...(typeof details.http_status === 'number' ? { http_status: details.http_status } : {}), ...(typeof details.api_code === 'number' || typeof details.api_code === 'string' && /^[A-Z0-9_]{1,64}$/.test(details.api_code) ? { api_code: details.api_code } : {}), resource_ids: ids });
        }
        if (result.ad_account_id !== account || resource && result.id !== resource || create && (result.name !== createList.parse(input).name || result.is_nca !== createList.parse(input).is_nca)) throw new AdportError('PROVIDER_ERROR', 'pinterest: customer-list receipt ownership/name/matching mode mismatch; reconcile before retrying', { resource_ids: [result.id] });
        return [result.id];
      });
    }
    if (op.tool === 'pinterest_create_audience') {
      const input = createAudience.parse(op.payload), rule = await this.rule(account, input.definition), body = { ad_account_id: account, name: input.name, ...(input.description !== undefined ? { description: input.description } : {}), audience_type: input.definition.audience_type, rule };
      return this.planWrite(`Create Pinterest ${input.definition.audience_type} audience “${input.name}”`, [JSON.stringify(body), 'Audience is unattached; it has no pause state. Visitor prefill is an explicit choice. Website listing verifies owner association, not native engagement eligibility.'], async () => this.receipt(account, undefined, body, await this.client.mutate(`${this.base(account)}/audiences`, 'POST', body, audience)));
    }
    if (op.tool === 'pinterest_remove_audience') {
      const input = removeAudience.parse(op.payload), current = await this.usage(account, input.audience_id);
      if (current.context_hash !== input.expected_context_hash || !current.scan_complete) throw new AdportError('PENDING_MISMATCH', 'pinterest: audience usage changed or is incomplete; read it again');
      if (current.references.length || current.shared_accounts.length) throw new AdportError('INVALID_INPUT', 'pinterest: audience still has targeting, derived audiences or sharing references');
      return this.planWrite(`Remove Pinterest audience “${current.audience.name ?? input.audience_id}”`, [`Native operation_type REMOVE on ${input.audience_id}; current visible usage/sharing is empty. This is a permanent audience operation, not a pause.`, 'Customer-list containers and project media are preserved; native concurrent writes are not frozen.'], async () => this.receipt(account, input.audience_id, {}, await this.client.mutate(`${this.base(account)}/audiences/${input.audience_id}`, 'PATCH', { operation_type: 'REMOVE' }, audience)));
    }
    const replacement = op.tool === 'pinterest_replace_audience_rule', input = replacement ? replaceRule.parse(op.payload) : updateAudience.parse(op.payload), current = replacement ? await this.usage(account, input.audience_id) : await this.get(account, input.audience_id);
    if (current.snapshot_hash !== input.expected_snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'pinterest: audience copy/configuration changed; read it again');
    const body: Row = { operation_type: 'UPDATE' }, changes: NonNullable<WritePreview['fieldChanges']> = [];
    if (replacement) {
      const value = replaceRule.parse(input), context = current as Awaited<ReturnType<PinterestAudienceService['usage']>>;
      if (context.context_hash !== value.expected_context_hash || !context.scan_complete) throw new AdportError('PENDING_MISMATCH', 'pinterest: audience usage changed or is incomplete; read it again');
      if (context.shared_accounts.length) throw new AdportError('INVALID_INPUT', 'pinterest: shared audience rules cannot be replaced through this workflow');
      if (value.definition.audience_type !== current.audience.audience_type) throw new AdportError('INVALID_INPUT', 'pinterest: rule replacement must preserve audience type');
      if (value.definition.audience_type === 'ACTALIKE' && value.definition.seeds.some(seed => seed.audience_id === input.audience_id || context.references.some(ref => ref.kind === 'derived_audience' && ref.id === seed.audience_id))) throw new AdportError('INVALID_INPUT', 'pinterest: an audience cannot use itself or a direct derived audience as a seed');
      body.rule = await this.rule(account, value.definition); changes.push({ field: 'Rule', before: JSON.stringify(current.audience.rule ?? null), after: JSON.stringify(body.rule) });
    } else {
      const value = updateAudience.parse(input);
      for (const key of ['name', 'description'] as const) if (value[key] !== undefined) { body[key] = value[key]; if ((current.audience[key] ?? null) !== value[key]) changes.push({ field: key === 'name' ? 'Name' : 'Description', before: String(current.audience[key] ?? '(not set)'), after: String(value[key] ?? '(cleared)') }); }
    }
    return this.planWrite(`Edit Pinterest audience “${current.audience.name ?? input.audience_id}”`, [replacement ? 'Replaces the complete definition and can affect every visible linked ad group. Usage is rechecked; source type and sharing are preserved.' : 'Only supplied copy fields change. Rules, membership sources and delivery are preserved.', JSON.stringify(body)], async () => this.receipt(account, input.audience_id, body, await this.client.mutate(`${this.base(account)}/audiences/${input.audience_id}`, 'PATCH', body, audience), current.audience), changes);
  }
  private receipt(account: string, resource: string | undefined, expected: Row, current: z.infer<typeof audience>, previous?: z.infer<typeof audience>) {
    const fields = Object.entries(expected).filter(([key]) => key !== 'operation_type');
    if (current.ad_account_id !== account || resource && current.id !== resource || fields.some(([key, value]) => key === 'rule' ? !includesFields(normalizeRule(current.rule), normalizeRule(value)) : digest(current[key] ?? null) !== digest(value)) || previous && ['name', 'description', 'rule', 'audience_type', 'is_nca'].some(key => expected[key] === undefined && digest(current[key] ?? null) !== digest(previous[key] ?? null))) throw new AdportError('PROVIDER_ERROR', 'pinterest: audience receipt differs from approved fields or preserved ownership/configuration; reconcile before retrying', { resource_ids: [current.id] });
    return [current.id];
  }
}

export function pinterestAudienceTools(provider: PinterestAdsProvider): AnyToolDefinition[] {
  const account = { account_id: id }, page = { page_size: z.number().int().min(1).max(250).default(50), bookmark: z.string().min(1).max(4096).optional() };
  const read = <T extends z.ZodRawShape>(name: string, description: string, input: z.ZodObject<T>, handler: (input: z.output<z.ZodObject<T>>) => Promise<unknown>) => defineTool({ name, namespace: 'pinterest', description, input, annotations: { readOnly: true }, handler });
  const write = (name: string, description: string, payload: z.ZodObject, kind: WriteOperation['kind']) => guardedWriteTool({ name, namespace: 'pinterest', provider: 'pinterest', description, payload, kind });
  return [
    read('pinterest_audiences', 'List native OWNED or RECEIVED audiences with ownership labels and snapshots. Received audiences remain read-only. Uses native bookmark pagination; processing status is not ad delivery.', z.object({ ...account, ...page, ownership_type: z.enum(['OWNED', 'RECEIVED']).default('OWNED') }), v => provider.audiences.list(v)),
    defineTool({ name: 'pinterest_get_audience', namespace: 'pinterest', description: 'Read an owned audience, rule, native processing status and snapshot, with read-only record view. Size/status can change independently; ownership must be explicit.', input: z.object({ ...account, audience_id: id }), output: creativesOutput.passthrough(), presentation: 'records', annotations: { readOnly: true }, handler: v => provider.audiences.get(v.account_id, v.audience_id) }),
    read('pinterest_audience_usage', 'Read owned audience targeting/derived references and both ad-account/business sharing edges. Bounded5,000 rows per inventory; incomplete or shared usage blocks removal. No native atomic freeze is claimed.', z.object({ ...account, audience_id: id }), v => provider.audiences.usage(v.account_id, v.audience_id)),
    read('pinterest_audience_sources', 'Read the advertiser owner’s native website inventory for engagement audience setup. Global websites require user_accounts:read and matching token owner. Does not claim/verify websites or certify audience eligibility.', z.object(account), v => provider.audiences.sources(v.account_id)),
    read('pinterest_customer_lists', 'Read selected advertiser customer-list metadata, counts, processing status and snapshots with pagination. Never returns records or native exception contents.', z.object({ ...account, ...page }), v => provider.audiences.customerLists(v)),
    read('pinterest_get_customer_list', 'Read an explicitly owned customer-list source and snapshot including batch counters. Matching is asynchronous; fewer than100 Pinterest accounts cannot serve. No source identifiers are returned.', z.object({ ...account, customer_list_id: id }), v => provider.audiences.getCustomerList(v.account_id, v.customer_list_id)),
    write('pinterest_create_audience', 'Create CUSTOMER_LIST, VISITOR, ENGAGEMENT or ACTALIKE audience from verified owned sources. Customer/seed snapshots are required; visitor prefill is explicit. No ad attachment, events or tracking installation. Native source eligibility remains authoritative.', createAudience, 'create'),
    write('pinterest_update_audience', 'Edit supplied owned-audience name/description after matching its snapshot. Null clears description; omitted copy, rules, source type and membership remain unchanged. Shared audiences are rejected.', updateAudience, 'update'),
    write('pinterest_replace_audience_rule', 'Replace a complete audience rule of the SAME type after matching configuration and complete usage context. Source ownership is reverified; shared rules are blocked. Existing linked ad groups can be affected.', replaceRule, 'update'),
    write('pinterest_remove_audience', 'Request native permanent audience REMOVE only after snapshot-bound complete usage/sharing scans find no references. Requires confirm_permanent_removal; does not delete a customer-list container. No atomic provider usage freeze.', removeAudience, 'remove'),
    write('pinterest_create_customer_list', 'Upload up to10,000 unique pre-normalized SHA-256 EMAIL/IDFA/MAID identifiers into a named list. Requires data rights confirmation; is_nca defaults false. Preview shows only count/digest. Acceptance is not matching success; native lists have no container-delete endpoint.', createList, 'create'),
    write('pinterest_update_customer_list_records', 'ADD/REMOVE up to10,000 SHA-256 records on an owned, snapshot-bound customer list. Confirms data rights, preserves list type and matching mode, and previews count/digest only. Native errors cannot expose identifiers. No automatic retry.', updateRecords, 'update'),
  ];
}
