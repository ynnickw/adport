import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import { MetaGraphClient, normalizeAccountId } from './client.js';
import type { MetaAdsProvider } from './provider.js';

type Row = Record<string, unknown>;
type Plan = Omit<WritePreview, 'serverValidated'> & { serverValidated: false; execute: (validateOnly: boolean) => Promise<string[]> };
const id = z.string().regex(/^\d+$/), accountId = z.string().regex(/^(act_)?\d+$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const cursor = z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]+$/);
const name = z.string().min(1);
const metadata = { name, description: z.string().optional() };
const selected = { audience_id: id, expected_snapshot_hash: hash };
const website = { pixel_id: id, url_contains: z.string().min(1).max(2048), retention_seconds: z.number().int().positive() };
const createCustomer = z.object({ ...metadata, customer_file_source: z.enum(['USER_PROVIDED_ONLY', 'PARTNER_PROVIDED_ONLY', 'BOTH_USER_AND_PARTNER_PROVIDED']) });
const update = z.object({ ...selected, name: name.optional(), description: z.string().optional() }).refine(value => value.name !== undefined || value.description !== undefined, 'Supply name or description');
const createWebsite = z.object({ ...metadata, ...website, prefill: z.boolean() });
const updateWebsite = z.object({ ...selected, expected_context_hash: hash, ...website, name: name.optional(), description: z.string().optional() });
const lookalike = z.object({ ...metadata, origin_audience_id: id, expected_source_hash: hash, country: z.string().regex(/^[A-Z]{2}$/), ratio: z.number().gt(0).lt(1), starting_ratio: z.number().min(0).lt(1).optional() }).refine(value => value.starting_ratio === undefined || value.starting_ratio < value.ratio, 'starting_ratio must be less than ratio');
const row = z.record(z.string(), z.unknown());
const audienceView = z.object({ audience: row, snapshot_hash: hash });
const referenceView = z.object({ kind: z.enum(['ad_set', 'saved_audience', 'audience']), id, name: z.string().optional(), status: z.string().optional(), effective_status: z.string().optional() });
const usageView = audienceView.extend({ references: z.array(referenceView), shared_accounts: z.array(z.string()), derived_audience_ids: z.array(z.string()), scan_complete: z.boolean(), context_hash: hash, notes: z.array(z.string()) });

const fields = 'id,account_id,name,description,subtype,customer_file_source,pixel_id,retention_days,rule,rule_v2,lookalike_spec,seed_audience,is_value_based,lookalike_audience_ids,permission_for_actions,sharing_status,delivery_status,operation_status,approximate_count_lower_bound,approximate_count_upper_bound';
const configurationFields = ['id', 'account_id', 'name', 'description', 'subtype', 'customer_file_source', 'pixel_id', 'retention_days', 'rule', 'rule_v2', 'lookalike_spec', 'seed_audience', 'is_value_based', 'permission_for_actions', 'sharing_status', 'lookalike_audience_ids'];
const writes = new Set(['meta_create_custom_audience', 'meta_update_custom_audience', 'meta_delete_custom_audience', 'meta_create_website_audience', 'meta_update_website_audience', 'meta_create_lookalike_audience']);
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const nativeId = (value: unknown): string | undefined => typeof value === 'string' && /^\d+$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
function contains(value: unknown, audience: string): boolean {
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new AdportError('PROVIDER_ERROR', 'Meta returned an audience reference outside the safe integer range.');
  if (value === audience || (typeof value === 'number' && nativeId(value) === audience)) return true;
  if (Array.isArray(value)) return value.some(item => contains(item, audience));
  if (value !== null && typeof value === 'object') return Object.values(value).some(item => contains(item, audience));
  // Native audience rules are JSON strings; never execute their content.
  if (typeof value === 'string' && /^[\[{]/.test(value)) { try { return contains(JSON.parse(value), audience); } catch { throw new AdportError('PROVIDER_ERROR', 'Meta returned an audience rule that could not be inspected.'); } }
  return false;
}

/** Native contracts: Meta Business SDK efd8423a2e59, customaudience/adaccount and official audience examples. */
export class MetaAudienceService {
  constructor(private readonly client: MetaGraphClient) {}
  supports(tool: string) { return writes.has(tool); }

  private owned(value: Row, account: string, expectedId?: string): Row {
    if (!nativeId(value.id) || (expectedId !== undefined && value.id !== expectedId) || typeof value.account_id !== 'string' || normalizeAccountId(value.account_id) !== account) throw new AdportError('INVALID_INPUT', 'Meta audience does not belong to the selected ad account.');
    return value;
  }
  async list(input: { account_id: string; limit: number; cursor?: string }) {
    const account = normalizeAccountId(input.account_id);
    const page = await this.client.getPage<Row>(`act_${account}/customaudiences`, { fields, limit: String(input.limit), ...(input.cursor ? { after: input.cursor } : {}) });
    if (page.rows.length > input.limit) throw new AdportError('PROVIDER_ERROR', 'Meta returned an oversized audience page.');
    return { rows: page.rows.map(value => this.owned(value, account)), truncated: Boolean(page.next_cursor), ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}) };
  }
  async get(accountId: string, audienceId: string) {
    const account = normalizeAccountId(accountId);
    if (!/^\d+$/.test(audienceId)) throw new AdportError('INVALID_INPUT', 'Meta audience IDs must be numeric.');
    const audience = this.owned(await this.client.get<Row>(audienceId, { fields }), account, audienceId);
    const configuration = Object.fromEntries(configurationFields.filter(key => audience[key] !== undefined).map(key => [key, audience[key]]));
    return { audience, snapshot_hash: digest({ account, configuration }) };
  }
  private async inventory(path: string, params: Record<string, string>): Promise<{ rows: Row[]; complete: boolean }> {
    const rows: Row[] = [], cursors = new Set<string>(), ids = new Set<string>();
    let after: string | undefined;
    for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
      const page = await this.client.getPage<Row>(path, { ...params, limit: '100', ...(after ? { after } : {}) });
      if (page.rows.length > 100) throw new AdportError('PROVIDER_ERROR', 'Meta returned an oversized inventory page.');
      for (const value of page.rows) {
        const key = typeof value.id === 'string' ? value.id : undefined;
        if (!key || ids.has(key)) throw new AdportError('PROVIDER_ERROR', 'Meta returned an invalid or repeated inventory ID.');
        ids.add(key); rows.push(value);
      }
      if (!page.next_cursor) return { rows, complete: true };
      if (cursors.has(page.next_cursor)) throw new AdportError('PROVIDER_ERROR', 'Meta repeated an inventory cursor.');
      cursors.add(page.next_cursor); after = page.next_cursor;
    }
    return { rows, complete: false };
  }
  async usage(accountId: string, audienceId: string) {
    const account = normalizeAccountId(accountId), current = await this.get(account, audienceId);
    const [adsets, saved, audiences, sharing] = await Promise.all([
      this.inventory(`act_${account}/adsets`, { fields: 'id,account_id,name,status,effective_status,targeting', effective_status: JSON.stringify(['ACTIVE', 'ARCHIVED', 'CAMPAIGN_PAUSED', 'DELETED', 'IN_PROCESS', 'PAUSED', 'WITH_ISSUES']) }),
      this.inventory(`act_${account}/savedaudiences`, { fields: 'id,account{id,account_id},name,targeting' }),
      this.inventory(`act_${account}/customaudiences`, { fields: 'id,account_id,name,subtype,seed_audience,lookalike_spec,rule,rule_v2' }),
      this.inventory(`${audienceId}/adaccounts`, { fields: 'id,account_id' }),
    ]);
    const references: Array<z.infer<typeof referenceView>> = [];
    const add = (kind: z.infer<typeof referenceView>['kind'], value: Row) => {
      if (!nativeId(value.id)) throw new AdportError('PROVIDER_ERROR', 'Meta returned an invalid audience reference ID.');
      references.push({ kind, id: nativeId(value.id)!, ...(typeof value.name === 'string' ? { name: value.name } : {}), ...(typeof value.status === 'string' ? { status: value.status } : {}), ...(typeof value.effective_status === 'string' ? { effective_status: value.effective_status } : {}) });
    };
    for (const value of adsets.rows) {
      this.owned(value, account);
      if (contains(value.targeting, audienceId)) add('ad_set', value);
    }
    for (const value of saved.rows) {
      const owner = object(value.account);
      const ownerId = typeof owner.account_id === 'string' ? owner.account_id : typeof owner.id === 'string' ? owner.id : '';
      if (normalizeAccountId(ownerId) !== account) throw new AdportError('INVALID_INPUT', 'Meta saved audience does not belong to the selected ad account.');
      if (contains(value.targeting, audienceId)) add('saved_audience', value);
    }
    for (const value of audiences.rows) {
      this.owned(value, account);
      if (value.id !== audienceId && [value.seed_audience, value.lookalike_spec, value.rule, value.rule_v2].some(item => contains(item, audienceId))) add('audience', value);
    }
    const sharedAccounts = sharing.rows.map(value => {
      const owner = typeof value.account_id === 'string' ? value.account_id : typeof value.id === 'string' ? value.id : '';
      return normalizeAccountId(owner);
    }).filter(value => value !== account).sort();
    const derived = current.audience.lookalike_audience_ids;
    if (derived !== undefined && (!Array.isArray(derived) || derived.some(value => !nativeId(value)))) throw new AdportError('PROVIDER_ERROR', 'Meta returned invalid derived audience IDs.');
    const derivedIds = (derived as unknown[] | undefined ?? []).map(value => nativeId(value)!).sort();
    references.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    const complete = [adsets, saved, audiences, sharing].every(value => value.complete);
    const context = { snapshot_hash: current.snapshot_hash, references, shared_accounts: sharedAccounts, derived_audience_ids: derivedIds, scan_complete: complete };
    return { ...current, ...context, context_hash: digest(context), notes: ['Usage covers the visible selected-account ad sets (including paused, archived and deleted statuses), saved audiences, audience rules/derived sources and native shared-account edge.', 'Meta does not provide an atomic compare-and-set or a global freeze of audience usage. Usage is re-read at apply; concurrent native changes remain possible.', ...(!complete ? ['At least one inventory exceeded 5,000 rows or 50 pages. Deletion is blocked.'] : [])] };
  }
  private editable(audience: Row) {
    if (object(audience.permission_for_actions).can_edit !== true) throw new AdportError('INVALID_INPUT', 'Meta did not grant edit permission for this audience.');
  }
  private async availablePixel(account: string, pixelId: string) {
    const pixels = await this.inventory(`act_${account}/adspixels`, { fields: 'id,name' });
    if (!pixels.complete || !pixels.rows.some(value => value.id === pixelId)) throw new AdportError('INVALID_INPUT', 'The selected pixel was not verified in the ad account pixel inventory.');
  }
  private websiteRule(input: z.infer<typeof createWebsite> | z.infer<typeof updateWebsite>) {
    return { inclusions: { operator: 'or', rules: [{ event_sources: [{ id: input.pixel_id, type: 'pixel' }], retention_seconds: input.retention_seconds, filter: { operator: 'and', filters: [{ field: 'url', operator: 'i_contains', value: input.url_contains }] } }] } };
  }
  private post(path: string, body: Row, summary: string, changes: string[], create: boolean, fieldChanges?: WritePreview['fieldChanges'], notes: string[] = []): Plan {
    return { summary, changes, coercions: [], budgetDeltas: [], serverValidated: false, ...(fieldChanges ? { fieldChanges } : {}), notes: ['Local preview only: these audience endpoints do not advertise validate_only in the official SDK.', ...notes], execute: async () => {
      const result = await this.client.post<unknown>(path, body);
      if (create) {
        const created = nativeId(object(result).id);
        if (!created) throw new AdportError('PROVIDER_ERROR', 'Meta did not return an audience ID. Inspect the account inventory before retrying this creation.');
        return [created];
      }
      if (result !== true && object(result).success !== true) throw new AdportError('PROVIDER_ERROR', 'Meta did not confirm the audience update. Read its current state before retrying.', { resourceIds: [path] });
      return [path];
    } };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const account = normalizeAccountId(op.accountId);
    if (op.tool === 'meta_create_custom_audience') {
      const input = createCustomer.parse(op.payload);
      return this.post(`act_${account}/customaudiences`, { ...input, subtype: 'CUSTOM' }, `Create empty Meta audience "${input.name}"`, ['+ Empty customer-list container; no customer records uploaded and no delivery attachment.'], true);
    }
    if (op.tool === 'meta_create_website_audience') {
      const input = createWebsite.parse(op.payload); await this.availablePixel(account, input.pixel_id);
      const rule = this.websiteRule(input);
      return this.post(`act_${account}/customaudiences`, { name: input.name, ...(input.description !== undefined ? { description: input.description } : {}), rule, prefill: input.prefill }, `Create Meta website audience "${input.name}"`, [`+ Pixel ${input.pixel_id}; URL contains ${JSON.stringify(input.url_contains)} (case insensitive); retention ${input.retention_seconds} seconds.`, `Historical prefill: ${input.prefill}. No events are sent and the audience is not attached to delivery.`], true, undefined, ['Membership is derived from pixel data. Native retention, eligibility and terms checks remain authoritative.']);
    }
    if (op.tool === 'meta_create_lookalike_audience') {
      const input = lookalike.parse(op.payload), source = await this.get(account, input.origin_audience_id);
      if (source.snapshot_hash !== input.expected_source_hash) throw new AdportError('PENDING_MISMATCH', 'Meta source audience changed; read it again before previewing.');
      if (object(source.audience.permission_for_actions).subtype_supports_lookalike === false || source.audience.subtype === 'LOOKALIKE') throw new AdportError('INVALID_INPUT', 'Meta does not support this source for a lookalike audience.');
      const spec = { type: 'custom_ratio', country: input.country, ratio: input.ratio, ...(input.starting_ratio !== undefined ? { starting_ratio: input.starting_ratio } : {}) };
      return this.post(`act_${account}/customaudiences`, { name: input.name, ...(input.description !== undefined ? { description: input.description } : {}), subtype: 'LOOKALIKE', origin_audience_id: input.origin_audience_id, lookalike_spec: spec }, `Create Meta lookalike "${input.name}"`, [`+ Source ${input.origin_audience_id}; ${input.country}; ratio ${input.starting_ratio ?? 0} → ${input.ratio}.`, 'No customer records uploaded or delivery attachment.'], true, undefined, ['Native source size, matching readiness, country, ratio and eligibility checks are authoritative. Suppressed counts do not establish seed eligibility.']);
    }
    if (op.tool === 'meta_delete_custom_audience') {
      const input = z.object({ audience_id: id, expected_context_hash: hash }).parse(op.payload), context = await this.usage(account, input.audience_id);
      if (context.context_hash !== input.expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'Meta audience usage changed; read its usage and request a fresh preview.');
      this.editable(context.audience);
      if (!context.scan_complete || context.references.length || context.shared_accounts.length || context.derived_audience_ids.length || Object.values(object(context.audience.sharing_status)).some(value => value !== null && value !== '' && value !== false)) throw new AdportError('INVALID_INPUT', 'Cannot delete an audience with references, sharing, derived audiences or incomplete usage verification.');
      return { summary: `Permanently delete Meta audience "${context.audience.name ?? input.audience_id}"`, changes: [`- Audience ${input.audience_id} and its membership; cannot be undone.`, 'Visible usage and sharing were rechecked; no ad status or budget is changed.'], coercions: [], budgetDeltas: [], serverValidated: false, notes: context.notes, execute: async () => {
        const result = await this.client.delete<unknown>(input.audience_id);
        if (result !== true && object(result).success !== true) throw new AdportError('PROVIDER_ERROR', 'Meta did not confirm audience deletion. Inspect native state before retrying.', { resourceIds: [input.audience_id] });
        return [input.audience_id];
      } };
    }
    if (op.tool === 'meta_update_custom_audience' || op.tool === 'meta_update_website_audience') {
      const websiteInput = op.tool === 'meta_update_website_audience' ? updateWebsite.parse(op.payload) : undefined;
      const input = websiteInput ?? update.parse(op.payload);
      const usage = websiteInput ? await this.usage(account, input.audience_id) : undefined;
      const current = usage ?? await this.get(account, input.audience_id);
      if (current.snapshot_hash !== input.expected_snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'Meta audience configuration changed; read it again before previewing.');
      this.editable(current.audience);
      const body: Row = {}, changes: WritePreview['fieldChanges'] = [];
      for (const key of ['name', 'description'] as const) if (input[key] !== undefined) { body[key] = input[key]; changes.push({ field: key, before: String(current.audience[key] ?? ''), after: input[key] }); }
      const notes = ['Omitted metadata, membership rules, budgets and ad-set targeting are preserved. Audiences have no pause state.'];
      if (websiteInput) {
        if (!usage?.scan_complete || usage.context_hash !== websiteInput.expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'Meta audience usage changed or could not be fully inspected; read its usage and request a fresh preview.');
        if (current.audience.subtype !== 'WEBSITE') throw new AdportError('INVALID_INPUT', 'Only a WEBSITE audience can receive this website rule.');
        await this.availablePixel(account, websiteInput.pixel_id);
        const rule = this.websiteRule(websiteInput); body.rule = rule;
        changes.push({ field: 'rule', before: String(current.audience.rule_v2 ?? current.audience.rule ?? ''), after: JSON.stringify(rule) });
        notes[0] = 'This replaces the entire website membership rule, including exclusions and other conditions. Existing targeting may be affected; ad statuses and budgets are preserved.';
        notes.push(`Visible references: ${JSON.stringify(usage.references)}. Shared ad accounts: ${JSON.stringify(usage.shared_accounts)}. Derived audience IDs: ${JSON.stringify(usage.derived_audience_ids)}.`, ...usage.notes);
      }
      return this.post(input.audience_id, body, `Update Meta audience "${current.audience.name ?? input.audience_id}"`, changes.map(change => `~ ${change.field}: ${change.before} → ${change.after}`), false, changes, notes);
    }
    throw new AdportError('INVALID_INPUT', `Unsupported Meta audience operation ${op.tool}.`);
  }
}

export function metaAudienceTools(provider: MetaAdsProvider): AnyToolDefinition[] {
  const write = (tool: string, description: string, payload: z.ZodObject, kind: 'create' | 'update' | 'remove') => guardedWriteTool({ name: tool, namespace: 'meta', provider: 'meta', kind, destructive: kind !== 'create', description, payload });
  return [
    defineTool({ name: 'meta_list_custom_audiences', namespace: 'meta', description: 'List owned audience configuration and native readiness/count bounds. Continue next_cursor as cursor; no customer records are returned.', input: z.object({ account_id: accountId, limit: z.number().int().positive().max(200).default(50), cursor: cursor.optional() }), output: z.object({ rows: z.array(row), truncated: z.boolean(), next_cursor: cursor.optional() }), pagination: { cursorInput: 'cursor' }, annotations: { readOnly: true }, handler: input => provider.audiences.list(input) }),
    defineTool({ name: 'meta_get_custom_audience', namespace: 'meta', description: 'Read owned audience configuration and snapshot_hash for edits/lookalike creation. Volatile size/readiness values are excluded from the hash.', input: z.object({ account_id: accountId, audience_id: id }), output: audienceView, annotations: { readOnly: true }, handler: input => provider.audiences.get(input.account_id, input.audience_id) }),
    defineTool({ name: 'meta_custom_audience_usage', namespace: 'meta', description: 'Inspect selected-account ad-set, saved-audience and audience references, derived lookalikes and native sharing before deletion. Returns context_hash and bounded scan completeness; no global or atomic usage guarantee.', input: z.object({ account_id: accountId, audience_id: id }), output: usageView, annotations: { readOnly: true }, handler: input => provider.audiences.usage(input.account_id, input.audience_id) }),
    write('meta_create_custom_audience', 'Create an empty customer-list audience container. Does not upload customer data or attach the audience to delivery.', createCustomer, 'create'),
    write('meta_update_custom_audience', 'Edit audience name/description with expected_snapshot_hash. Omission preserves metadata; an empty description clears it. Membership, targeting and delivery settings are preserved.', update, 'update'),
    write('meta_delete_custom_audience', 'Permanently delete an owned editable audience with expected_context_hash from meta_custom_audience_usage. Refuses visible references, sharing, derived audiences and incomplete scans; rechecks at apply.', z.object({ audience_id: id, expected_context_hash: hash }), 'remove'),
    write('meta_create_website_audience', 'Create a URL-contains website audience from a pixel verified in this account. retention_seconds and explicit historical prefill are required. No events sent or delivery attachment; native eligibility applies.', createWebsite, 'create'),
    write('meta_update_website_audience', 'Replace the full WEBSITE membership rule with a case-insensitive URL-contains rule and retention_seconds. Requires expected_snapshot_hash and expected_context_hash from usage, plus an account-available pixel. Existing audience use may be affected; omitted metadata and ad statuses/budgets are preserved.', updateWebsite, 'update'),
    write('meta_create_lookalike_audience', 'Create an unattached custom-ratio lookalike from an owned source with expected_source_hash. country uses two uppercase letters; ratio/starting_ratio are fractions. Native eligibility and seed readiness remain authoritative.', lookalike, 'create'),
  ];
}
