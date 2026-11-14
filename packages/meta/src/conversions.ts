import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import { MetaGraphClient, normalizeAccountId } from './client.js';
import type { MetaAdsProvider } from './provider.js';

type Row = Record<string, unknown>;
type Plan = Omit<WritePreview, 'serverValidated'> & { serverValidated: false; execute: (validateOnly: boolean) => Promise<string[]>; resultDetails?: () => Row; resultWarnings?: () => string[] };
const id = z.string().regex(/^\d+$/), accountId = z.string().regex(/^(act_)?\d+$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const cursor = z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]+$/);
const name = z.string().trim().min(1).max(255), description = z.string().max(4096);
const nativeValue = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).describe('Native Meta request value, forwarded unchanged. No cents, micros or currency conversion is performed.');
const eventType = z.enum(['ADD_PAYMENT_INFO', 'ADD_TO_CART', 'ADD_TO_WISHLIST', 'COMPLETE_REGISTRATION', 'CONTACT', 'CONTENT_VIEW', 'CUSTOMIZE_PRODUCT', 'DONATE', 'FACEBOOK_SELECTED', 'FIND_LOCATION', 'INITIATED_CHECKOUT', 'LEAD', 'LISTING_INTERACTION', 'OTHER', 'PURCHASE', 'SCHEDULE', 'SEARCH', 'START_TRIAL', 'SUBMIT_APPLICATION', 'SUBSCRIBE']);
const aggregation = z.enum(['count', 'device_type', 'host', 'pixel_fire', 'unmatched_count', 'unmatched_usd_amount', 'url', 'usd_amount']);
const timestamp = z.iso.datetime({ offset: true });
const row = z.record(z.string(), z.unknown());
const record = z.object({ id, name: z.string(), status: z.string(), source: z.string().optional(), event: z.string().optional() });
const getOutput = z.object({ conversion: row, snapshot_hash: hash, records: z.array(record) });
const listOutput = z.object({ conversions: z.array(row), records: z.array(record), truncated: z.boolean(), next_cursor: cursor.optional() });
const statsInput = z.strictObject({ account_id: accountId, conversion_id: id, aggregation: aggregation.default('count'), start_time: timestamp, end_time: timestamp, limit: z.number().int().min(1).max(100).default(50), cursor: cursor.optional() }).refine(input => Date.parse(input.start_time) < Date.parse(input.end_time), 'start_time must be before end_time');
const createInput = z.strictObject({ name, description: description.optional(), event_source_id: id.describe('Pixel ID from the selected account pixel inventory'), rule: z.string().min(2).max(16384).describe('Native Meta rule as a JSON object string; Meta validates its rule grammar.'), custom_event_type: eventType, default_conversion_value: nativeValue.optional() });
const selected = { conversion_id: id, expected_snapshot_hash: hash, acknowledge_shared_effects: z.literal(true) };
const updateInput = z.strictObject({ ...selected, name: name.optional(), description: description.optional(), default_conversion_value: nativeValue.optional() }).refine(input => input.name !== undefined || input.description !== undefined || input.default_conversion_value !== undefined, 'Supply name, description or default_conversion_value');
const deleteInput = z.strictObject({ conversion_id: id, expected_context_hash: hash, acknowledge_shared_effects: z.literal(true) });
const fields = 'id,account_id,name,description,rule,advanced_rule,custom_event_type,default_conversion_value,event_source_type,action_source_type,pixel{id,name},is_archived,is_unavailable,creation_time,first_fired_time,last_fired_time';
const configurationFields = ['id', 'account_id', 'name', 'description', 'rule', 'advanced_rule', 'custom_event_type', 'default_conversion_value', 'event_source_type', 'action_source_type', 'pixel', 'is_archived', 'is_unavailable'];
const returnedFields = [...configurationFields, 'creation_time', 'first_fired_time', 'last_fired_time'];
const writes = new Set(['meta_create_custom_conversion', 'meta_update_custom_conversion', 'meta_delete_custom_conversion']);
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const localNotice = 'Local preview only: these custom-conversion endpoints do not advertise validate_only in the official Meta SDK.';
const sharingNotice = 'Changes can affect measurement and optimization wherever this conversion is used, including other accounts. Selected-account usage is not a global or atomic usage guarantee.';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function bounded(value: unknown, source: 'input' | 'provider'): void {
  let nodes = 0;
  const fail = () => { throw new AdportError(source === 'input' ? 'INVALID_INPUT' : 'PROVIDER_ERROR', 'Meta JSON exceeds safe structural bounds or contains an unsafe numeric value.'); };
  const walk = (item: unknown, depth: number) => {
    if (++nodes > 5000 || depth > 12) fail();
    if (typeof item === 'number' && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) fail();
    if (item !== null && typeof item === 'object') for (const child of Object.values(item)) walk(child, depth + 1);
  };
  walk(value, 0);
  if (JSON.stringify(value).length > 131072) fail();
}
function parseRule(value: string, source: 'input' | 'provider'): Row {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new AdportError(source === 'input' ? 'INVALID_INPUT' : 'PROVIDER_ERROR', 'Meta conversion rule must be a JSON object string.'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) throw new AdportError(source === 'input' ? 'INVALID_INPUT' : 'PROVIDER_ERROR', 'Meta conversion rule must be a nonempty JSON object.');
  bounded(parsed, source);
  return parsed as Row;
}
const ruleDigest = (value: unknown) => typeof value === 'string' ? digest(parseRule(value, 'provider')) : undefined;
const configurationValue = (key: string, value: unknown) => key === 'pixel' ? { id: object(value).id } : value;
const valueWarnings = (requested: number | undefined, reported: unknown) => requested !== undefined && String(requested) !== String(reported)
  ? ['Meta reported a different native default conversion value than the request. Both values are in the receipt; unit conversion and value equivalence are unverified. Read the conversion before relying on its default value.'] : [];
const confirmed = (value: unknown) => value === true || object(value).success === true;
function uncertain(message: string, resourceId?: string): never {
  throw new AdportError('PROVIDER_ERROR', `${message} Inspect native state before retrying; the mutation is not replayed automatically.`, resourceId ? { resourceIds: [resourceId] } : undefined);
}

/** Contracts verified against official Meta Business SDK v25.0.3 and v26.0.3; see docs/providers/meta-conversions.md. */
export class MetaConversionService {
  constructor(private readonly client: MetaGraphClient) {}
  supports(tool: string) { return writes.has(tool); }
  private owned(value: unknown, account: string, expectedId?: string): Row {
    const result = object(value);
    bounded(result, 'provider');
    if (typeof result.id !== 'string' || !/^\d+$/.test(result.id) || (expectedId !== undefined && result.id !== expectedId) || typeof result.account_id !== 'string' || normalizeAccountId(result.account_id) !== account) throw new AdportError('INVALID_INPUT', 'Meta custom conversion does not belong to the selected ad account. Shared foreign-owned conversions are read-only through their owner account.');
    return Object.fromEntries(returnedFields.filter(key => result[key] !== undefined).map(key => [key, key === 'pixel' ? Object.fromEntries(['id', 'name'].filter(field => object(result.pixel)[field] !== undefined).map(field => [field, object(result.pixel)[field]])) : result[key]]));
  }
  private records(conversions: Row[]) {
    return conversions.map(value => ({ id: String(value.id), name: typeof value.name === 'string' ? value.name : String(value.id), status: value.is_archived === true ? 'Archived' : value.is_unavailable === true ? 'Unavailable' : 'Configured', ...(typeof object(value.pixel).id === 'string' ? { source: String(object(value.pixel).id) } : {}), ...(typeof value.custom_event_type === 'string' ? { event: value.custom_event_type } : {}) }));
  }
  async list(input: { account_id: string; limit: number; cursor?: string }) {
    const account = normalizeAccountId(input.account_id);
    const page = await this.client.getPage<unknown>(`act_${account}/customconversions`, { fields, limit: String(input.limit), ...(input.cursor ? { after: input.cursor } : {}) });
    if (page.rows.length > input.limit) throw new AdportError('PROVIDER_ERROR', 'Meta returned an oversized custom-conversion page.');
    if (page.next_cursor && page.next_cursor === input.cursor) throw new AdportError('PROVIDER_ERROR', 'Meta repeated a custom-conversion cursor.');
    const conversions = page.rows.map(value => this.owned(value, account));
    if (new Set(conversions.map(value => value.id)).size !== conversions.length) throw new AdportError('PROVIDER_ERROR', 'Meta repeated a custom-conversion ID.');
    return { conversions, records: this.records(conversions), truncated: Boolean(page.next_cursor), ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}) };
  }
  async get(accountId: string, conversionId: string) {
    const account = normalizeAccountId(accountId); id.parse(conversionId);
    const conversion = this.owned(await this.client.get<unknown>(conversionId, { fields }), account, conversionId);
    const configuration = Object.fromEntries(configurationFields.filter(key => conversion[key] !== undefined).map(key => [key, configurationValue(key, conversion[key])]));
    return { conversion, snapshot_hash: digest({ account, configuration }), records: this.records([conversion]) };
  }
  private async inventory(path: string, params: Record<string, string>): Promise<{ rows: Row[]; complete: boolean }> {
    const rows: Row[] = [], cursors = new Set<string>(), ids = new Set<string>();
    let after: string | undefined;
    for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
      const page = await this.client.getPage<Row>(path, { ...params, limit: '100', ...(after ? { after } : {}) });
      if (page.rows.length > 100) throw new AdportError('PROVIDER_ERROR', 'Meta returned an oversized conversion context page.');
      for (const value of page.rows) {
        bounded(value, 'provider');
        if (typeof value.id !== 'string' || !/^\d+$/.test(value.id) || ids.has(value.id)) throw new AdportError('PROVIDER_ERROR', 'Meta returned an invalid or repeated conversion context ID.');
        ids.add(value.id); rows.push(value);
      }
      if (!page.next_cursor) return { rows, complete: true };
      if (cursors.has(page.next_cursor) || page.next_cursor === after) throw new AdportError('PROVIDER_ERROR', 'Meta repeated a conversion context cursor.');
      cursors.add(page.next_cursor); after = page.next_cursor;
    }
    return { rows, complete: false };
  }
  async usage(accountId: string, conversionId: string) {
    const account = normalizeAccountId(accountId), current = await this.get(account, conversionId);
    const inventory = await this.inventory(`act_${account}/adsets`, { fields: 'id,account_id,name,status,effective_status,promoted_object', effective_status: JSON.stringify(['ACTIVE', 'ARCHIVED', 'CAMPAIGN_PAUSED', 'DELETED', 'IN_PROCESS', 'PAUSED', 'WITH_ISSUES']) });
    const references = inventory.rows.filter(value => {
      if (typeof value.account_id !== 'string' || normalizeAccountId(value.account_id) !== account) throw new AdportError('INVALID_INPUT', 'Meta returned an ad set outside the selected ad account.');
      const reference = object(value.promoted_object).custom_conversion_id;
      if (reference === undefined || reference === null) return false;
      if (typeof reference !== 'string' || !/^\d+$/.test(reference)) throw new AdportError('PROVIDER_ERROR', 'Meta returned an unsafe custom-conversion reference.');
      return reference === conversionId;
    }).map(value => ({ id: String(value.id), ...(typeof value.name === 'string' ? { name: value.name } : {}), ...(typeof value.status === 'string' ? { status: value.status } : {}), ...(typeof value.effective_status === 'string' ? { effective_status: value.effective_status } : {}) })).sort((a, b) => a.id.localeCompare(b.id));
    return { ...current, references, scan_complete: inventory.complete, context_hash: digest({ snapshot: current.snapshot_hash, references, complete: inventory.complete }), notes: [sharingNotice, 'Usage scans cover at most 5,000 visible ad sets. Meta does not offer an atomic usage lock.'] };
  }
  async stats(input: z.infer<typeof statsInput>) {
    statsInput.parse(input);
    await this.get(input.account_id, input.conversion_id);
    const page = await this.client.getPage<unknown>(`${input.conversion_id}/stats`, { fields: 'aggregation,data,timestamp', aggregation: input.aggregation, start_time: input.start_time, end_time: input.end_time, limit: String(input.limit), ...(input.cursor ? { after: input.cursor } : {}) });
    if (page.rows.length > input.limit) throw new AdportError('PROVIDER_ERROR', 'Meta returned an oversized conversion stats page.');
    if (page.next_cursor && page.next_cursor === input.cursor) throw new AdportError('PROVIDER_ERROR', 'Meta repeated a conversion stats cursor.');
    const stats = page.rows.map(value => {
      const result = object(value); bounded(result, 'provider');
      if (result.aggregation !== input.aggregation || !Array.isArray(result.data) || result.data.some(item => item === null || typeof item !== 'object' || Array.isArray(item)) || typeof result.timestamp !== 'string') throw new AdportError('PROVIDER_ERROR', 'Meta returned invalid native custom-conversion stats.');
      return { aggregation: result.aggregation, data: result.data, timestamp: result.timestamp };
    });
    return { conversion_id: input.conversion_id, aggregation: input.aggregation, stats, truncated: Boolean(page.next_cursor), ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}) };
  }
  private editable(conversion: Row) {
    if (conversion.is_archived !== false || conversion.is_unavailable !== false) throw new AdportError('INVALID_INPUT', 'Meta conversion must explicitly be unarchived and available before editing or deletion.');
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const account = normalizeAccountId(op.accountId);
    if (op.tool === 'meta_create_custom_conversion') {
      const input = createInput.parse(op.payload), rule = parseRule(input.rule, 'input');
      const pixels = await this.inventory(`act_${account}/adspixels`, { fields: 'id,name' });
      if (!pixels.rows.some(value => value.id === input.event_source_id)) throw new AdportError('INVALID_INPUT', 'The conversion event source was not verified in the selected account pixel inventory.');
      const body = { ...input, rule: JSON.stringify(rule), action_source_type: 'website' };
      const notes = [localNotice, 'Creates a website custom-conversion definition from an account-available Pixel. Meta validates rule grammar and eligibility. No events are sent or tracking installed.', 'Native default conversion values are forwarded and reported unchanged; no currency unit conversion is inferred.'];
      let details: Row = {};
      return { summary: `Create Meta custom conversion "${input.name}"`, changes: [`+ Website custom conversion from Pixel ${input.event_source_id}; ${input.custom_event_type}.`, `Rule: ${body.rule}`], coercions: [], budgetDeltas: [], serverValidated: false, notes,
        review: { provider: 'meta', accountId: account, kind: 'create', title: 'Create custom conversion', subject: input.name, fields: [{ label: 'Pixel', after: input.event_source_id }, { label: 'Event', after: input.custom_event_type }, { label: 'Rule', after: body.rule }, ...(input.description !== undefined ? [{ label: 'Description', after: input.description }] : []), ...(input.default_conversion_value !== undefined ? [{ label: 'Default value (native request)', after: input.default_conversion_value }] : [])], notices: notes },
        resultDetails: () => details, resultWarnings: () => valueWarnings(input.default_conversion_value, object(details.conversion).default_conversion_value), execute: async validateOnly => {
          if (validateOnly) throw new AdportError('INVALID_INPUT', 'Meta custom conversions do not support native dry runs.');
          const result = object(await this.client.post<unknown>(`act_${account}/customconversions`, body));
          if (typeof result.id !== 'string' || !/^\d+$/.test(result.id)) uncertain('Meta did not return a custom-conversion ID.');
          const createdId = result.id;
          let current: Awaited<ReturnType<MetaConversionService['get']>>;
          try { current = await this.get(account, createdId); } catch { uncertain('Meta returned a creation ID but its owned configuration could not be read back.', createdId); }
          let sameRule = false;
          try { sameRule = ruleDigest(current.conversion.rule) === digest(rule); } catch { /* Report the known ID without replaying a possibly successful creation. */ }
          if (current.conversion.name !== input.name || object(current.conversion.pixel).id !== input.event_source_id || !sameRule || current.conversion.custom_event_type !== input.custom_event_type || (input.description !== undefined && current.conversion.description !== input.description)) uncertain('Created Meta conversion configuration differs from the approved definition.', createdId);
          details = { conversion: current.conversion, snapshot_hash: current.snapshot_hash, ...(input.default_conversion_value !== undefined ? { requested_default_conversion_value: input.default_conversion_value, reported_default_conversion_value: current.conversion.default_conversion_value ?? null } : {}) };
          return [createdId];
        } };
    }
    if (op.tool === 'meta_update_custom_conversion') {
      const input = updateInput.parse(op.payload), current = await this.get(account, input.conversion_id);
      if (current.snapshot_hash !== input.expected_snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'Meta conversion changed; read its configuration and request a fresh preview.');
      this.editable(current.conversion);
      const body: Row = {}, changes: NonNullable<WritePreview['fieldChanges']> = [];
      for (const key of ['name', 'description', 'default_conversion_value'] as const) if (input[key] !== undefined) { body[key] = input[key]; changes.push({ field: key === 'default_conversion_value' ? 'Default value (native)' : key, before: String(current.conversion[key] ?? ''), after: String(input[key]) }); }
      const notes = [localNotice, sharingNotice, 'Only supplied name, description and native default value are editable. Rules, event source, category, delivery and budgets are preserved. Native request/read values are reported without inferred currency conversion.'];
      let details: Row = {};
      return { summary: `Update Meta custom conversion "${current.conversion.name ?? input.conversion_id}"`, changes: changes.map(value => `~ ${value.field}: ${value.before} → ${value.after}`), fieldChanges: changes, coercions: [], budgetDeltas: [], serverValidated: false, notes,
        review: { provider: 'meta', accountId: account, kind: 'update', title: 'Edit custom conversion', subject: String(current.conversion.name ?? input.conversion_id), fields: changes.map(value => ({ label: value.field, before: value.before, after: value.after })), notices: notes }, resultDetails: () => details, resultWarnings: () => valueWarnings(input.default_conversion_value, object(details.conversion).default_conversion_value),
        execute: async validateOnly => {
          if (validateOnly) throw new AdportError('INVALID_INPUT', 'Meta custom conversions do not support native dry runs.');
          if (!confirmed(await this.client.post<unknown>(input.conversion_id, body))) uncertain('Meta did not confirm custom-conversion update.', input.conversion_id);
          let after: Awaited<ReturnType<MetaConversionService['get']>>;
          try { after = await this.get(account, input.conversion_id); } catch { uncertain('Meta acknowledged the update but its owned configuration could not be read back.', input.conversion_id); }
          const preserved = ['rule', 'advanced_rule', 'custom_event_type', 'pixel', 'action_source_type', 'event_source_type', 'is_archived', 'is_unavailable'];
          if (input.default_conversion_value === undefined) preserved.push('default_conversion_value');
          if (preserved.some(key => digest(configurationValue(key, current.conversion[key] ?? null)) !== digest(configurationValue(key, after.conversion[key] ?? null))) || ['name', 'description'].some(key => after.conversion[key] !== (body[key] ?? current.conversion[key]))) uncertain('Meta conversion readback did not preserve or apply the approved configuration.', input.conversion_id);
          details = { conversion: after.conversion, snapshot_hash: after.snapshot_hash, ...(input.default_conversion_value !== undefined ? { requested_default_conversion_value: input.default_conversion_value, reported_default_conversion_value: after.conversion.default_conversion_value ?? null } : {}) };
          return [input.conversion_id];
        } };
    }
    if (op.tool === 'meta_delete_custom_conversion') {
      const input = deleteInput.parse(op.payload), current = await this.usage(account, input.conversion_id);
      if (current.context_hash !== input.expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'Meta conversion usage changed; read its usage and request a fresh preview.');
      this.editable(current.conversion);
      if (!current.scan_complete || current.references.length) throw new AdportError('INVALID_INPUT', 'Cannot delete a conversion with visible ad-set references or an incomplete usage scan.');
      const notes = [localNotice, ...current.notes, 'Deletion cannot be undone through Adport. Meta may retain archived configuration and historical reporting.'];
      let details: Row = {};
      return { summary: `Delete Meta custom conversion "${current.conversion.name ?? input.conversion_id}"`, changes: [`- Custom conversion ${input.conversion_id}; native DELETE.`, 'No selected-account ad-set references were found. External and concurrent use remains possible.'], coercions: [], budgetDeltas: [], serverValidated: false, notes,
        review: { provider: 'meta', accountId: account, kind: 'remove', title: 'Delete custom conversion', subject: String(current.conversion.name ?? input.conversion_id), fields: [{ label: 'Conversion', after: input.conversion_id }, { label: 'Visible ad-set references', after: 0 }], notices: notes }, resultDetails: () => details,
        execute: async validateOnly => {
          if (validateOnly) throw new AdportError('INVALID_INPUT', 'Meta custom conversions do not support native dry runs.');
          if (!confirmed(await this.client.delete<unknown>(input.conversion_id))) uncertain('Meta did not confirm custom-conversion deletion.', input.conversion_id);
          let remaining: Awaited<ReturnType<MetaConversionService['inventory']>>;
          try { remaining = await this.inventory(`act_${account}/customconversions`, { fields }); } catch { uncertain('Meta acknowledged deletion but account inventory readback failed.', input.conversion_id); }
          let owned: Row[];
          try { owned = remaining.rows.map(value => this.owned(value, account)); } catch { uncertain('Meta acknowledged deletion but account inventory ownership could not be verified.', input.conversion_id); }
          const found = owned.find(value => value.id === input.conversion_id);
          if (found?.is_archived !== true && (found || !remaining.complete)) uncertain('Meta acknowledged deletion but absence or archived state is unconfirmed.', input.conversion_id);
          details = { deletion_readback: found ? 'ARCHIVED' : 'ABSENT_FROM_COMPLETE_ACCOUNT_INVENTORY', historical_reporting_may_be_retained: true };
          return [input.conversion_id];
        } };
    }
    throw new AdportError('INVALID_INPUT', `Unsupported Meta custom-conversion operation ${op.tool}.`);
  }
}

export function metaConversionTools(provider: MetaAdsProvider): AnyToolDefinition[] {
  const read = { readOnly: true, openWorld: false };
  const catalog = { category: 'measurement', exposure: 'specialist' } as const;
  return [
    defineTool({ name: 'meta_list_custom_conversions', namespace: 'meta', catalog, presentation: 'records', description: 'List account-owned Meta custom conversions with native cursor pagination. Foreign-owned shared conversions are rejected. Returns configuration without sending events.', input: z.strictObject({ account_id: accountId, limit: z.number().int().min(1).max(100).default(50), cursor: cursor.optional() }), output: listOutput, pagination: { cursorInput: 'cursor', cursorOutput: 'next_cursor' }, annotations: read, handler: input => provider.conversions.list(input) }),
    defineTool({ name: 'meta_get_custom_conversion', namespace: 'meta', catalog, presentation: 'records', description: 'Read an owned Meta custom-conversion definition and snapshot_hash for metadata edits. Native first/last event timestamps and Pixel name are excluded from the hash.', input: z.strictObject({ account_id: accountId, conversion_id: id }), output: getOutput, annotations: read, handler: input => provider.conversions.get(input.account_id, input.conversion_id) }),
    defineTool({ name: 'meta_custom_conversion_usage', namespace: 'meta', catalog, presentation: 'records', description: 'Scan visible selected-account ad-set references before deletion. Returns context_hash and bounded scan completeness; does not establish global sharing or usage.', input: z.strictObject({ account_id: accountId, conversion_id: id }), output: getOutput.extend({ references: z.array(z.object({ id, name: z.string().optional(), status: z.string().optional(), effective_status: z.string().optional() })), scan_complete: z.boolean(), context_hash: hash, notes: z.array(z.string()) }), annotations: read, handler: input => provider.conversions.usage(input.account_id, input.conversion_id) }),
    defineTool({ name: 'meta_custom_conversion_stats', namespace: 'meta', catalog, description: 'Read native custom-conversion stats for an owned conversion and explicit ISO time range. Preserves Meta aggregation/data/timestamp values; does not fabricate missing counts or convert currency. Continue next_cursor as cursor.', input: statsInput, output: z.object({ conversion_id: id, aggregation, stats: z.array(z.object({ aggregation, data: z.array(row), timestamp: z.string() })), truncated: z.boolean(), next_cursor: cursor.optional() }), pagination: { cursorInput: 'cursor', cursorOutput: 'next_cursor' }, annotations: read, handler: input => provider.conversions.stats(input) }),
    guardedWriteTool({ name: 'meta_create_custom_conversion', namespace: 'meta', provider: 'meta', catalog, kind: 'create', destructive: false, description: 'Create a website custom conversion from a Pixel verified in this account. Native rule JSON grammar is validated by Meta at apply. Preview is local; creates only a definition and sends no events.', payload: createInput }),
    guardedWriteTool({ name: 'meta_update_custom_conversion', namespace: 'meta', provider: 'meta', catalog, kind: 'update', description: 'Edit supplied name, description or native default value with expected_snapshot_hash. Omission preserves metadata; empty description clears it. Rule/source/category are immutable here. Requires acknowledging effects wherever this conversion is used.', payload: updateInput }),
    guardedWriteTool({ name: 'meta_delete_custom_conversion', namespace: 'meta', provider: 'meta', catalog, kind: 'remove', destructive: true, description: 'Delete an owned conversion with expected_context_hash from usage and shared-effects acknowledgement. Refuses visible ad-set references/incomplete scans. Rechecks at apply, then verifies native archived state or complete account-list absence; no restore operation.', payload: deleteInput }),
  ];
}
