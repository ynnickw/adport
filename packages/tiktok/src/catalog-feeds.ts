import { createHash } from 'node:crypto';
import { AdportError, type WriteOperation, type WritePreview, type ReviewField } from '@adport/core';
import { z } from 'zod';
import type { TikTokClient } from './client.js';
import { catalogId, catalogInput } from './catalog-schema.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const nativeId = z.union([catalogId, z.number().int().positive().safe()]).transform(String);
const count = z.number().int().nonnegative().safe();
const nativeTime = z.string().max(40).regex(/^[0-9TZ :.+-]*$/);
const mode = z.enum(['INCREMENTAL', 'OVERWRITE', 'SUPPLEMENT']);
const interval = z.enum(['HOURLY', 'DAILY', 'MONTHLY']);
const sourceUri = z.string().min(1).max(8192).refine(value => {
  try { const uri = new URL(value);return ['http:', 'https:', 'ftp:', 'sftp:'].includes(uri.protocol) && !!uri.hostname && !uri.username && !uri.password && !uri.hash && !/[\x00-\x20\x7f]/.test(value); } catch { return false; }
}, 'Use an HTTP(S), FTP or SFTP source URL without embedded credentials or a fragment');
const schedule = z.object({
  source: z.object({ uri: sourceUri, username: z.string().min(1).max(1024).optional(), password: z.string().min(1).max(4096).optional() }).strict(),
  interval_type: interval, interval_count: z.number().int().min(1).max(30).default(1),
  timezone: z.string().min(1).max(128).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value });return true; } catch { return false; } }, 'Use an IANA time zone'),
  day_of_month: z.number().int().min(1).max(31).optional(), hour: z.number().int().min(0).max(23).default(0), minute: z.number().int().min(0).max(59).default(0),
}).strict().superRefine((value, ctx) => {
  const max = { HOURLY: 23, DAILY: 30, MONTHLY: 12 }[value.interval_type];
  if (value.interval_count > max) ctx.addIssue({ code: 'custom', path: ['interval_count'], message: `Maximum ${value.interval_type.toLowerCase()} interval is ${max}` });
  if (value.day_of_month !== undefined && value.interval_type !== 'MONTHLY') ctx.addIssue({ code: 'custom', path: ['day_of_month'], message: 'day_of_month applies only to monthly schedules' });
  if (value.interval_type === 'MONTHLY' && value.day_of_month === undefined) ctx.addIssue({ code: 'custom', path: ['day_of_month'], message: 'Choose an explicit day for monthly schedules' });
});
const payload = catalogInput.omit({ account_id: true });
const selected = catalogInput.extend({ feed_id: catalogId }).strict();
export const catalogFeedList = catalogInput.extend({ feed_id: catalogId.optional(), page_size: z.number().int().min(1).max(100).default(30), cursor: z.string().min(1).max(512).optional() }).strict();
export const catalogFeedLog = selected;
export const catalogFeedCreate = payload.extend({
  feed_name: z.string().trim().min(1).max(256), update_mode: z.enum(['INCREMENTAL', 'OVERWRITE']), feed_type: z.enum(['DATA_FEED', 'COUNTRY_FEED']).optional(),
  schedule_param: schedule.optional(), expected_catalog_hash: hash, acknowledge_shared_effects: z.literal(true), acknowledge_automatic_processing: z.literal(true),
}).strict();
export const catalogFeedUpdate = payload.extend({
  feed_id: catalogId, update_mode: mode, schedule_param: schedule.optional(), expected_configuration_hash: hash,
  acknowledge_shared_effects: z.literal(true), acknowledge_automatic_processing: z.literal(true),
}).strict();
export const catalogFeedSwitch = payload.extend({ feed_id: catalogId, status: z.enum(['ON', 'OFF']), expected_configuration_hash: hash, acknowledge_shared_effects: z.literal(true), acknowledge_automatic_processing: z.literal(true) }).strict();
export const catalogFeedDelete = payload.extend({ feed_id: catalogId, expected_configuration_hash: hash, acknowledge_shared_effects: z.literal(true) }).strict();

const nativeSchedule = z.looseObject({
  uri: z.string().nullable().optional(), update_mode: mode.nullable().optional(), timezone: z.string().nullable().optional(), interval_type: interval.nullable().optional(),
  interval_count: count.nullable().optional(), day_of_month: count.nullable().optional(), hour: count.nullable().optional(), minute: count.nullable().optional(),
});
const feed = z.looseObject({
  feed_id: nativeId, feed_name: z.string(), feed_type: z.enum(['DATA_FEED', 'COUNTRY_FEED']).optional(), status: z.enum(['ON', 'OFF']).optional(),
  bc_id: nativeId.optional(), catalog_id: nativeId.optional(), region_codes: z.array(z.string()).optional(), override_fields: z.array(z.string()).optional(),
  last_update_param: nativeSchedule.nullable().optional(), next_update_time: nativeTime.nullable().optional(), number_of_products: count.optional(),
});
type Feed = z.infer<typeof feed>;
type Selection = z.infer<typeof catalogInput>;
type Parent = { configuration_hash: string; catalog_conf: Record<string, unknown> };
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const origin = (value: unknown) => { try { const uri = new URL(String(value));return `${uri.protocol}//${uri.host}`; } catch { return 'Not reported'; } };
const scheduleConfig = (value: Feed['last_update_param']) => ({ uri: value?.uri ?? null, update_mode: value?.update_mode ?? null, timezone: value?.timezone ?? null, interval_type: value?.interval_type ?? null, interval_count: value?.interval_count ?? null, hour: value?.hour ?? null, minute: value?.minute ?? null, day_of_month: value?.interval_type === 'MONTHLY' ? value.day_of_month ?? null : null });
const config = (value: Feed) => ({ feed_id: value.feed_id, feed_name: value.feed_name, feed_type: value.feed_type ?? null, status: value.status ?? null, region_codes: value.region_codes ?? [], override_fields: value.override_fields ?? [], schedule: scheduleConfig(value.last_update_param) });
const configurationHash = (scope: Selection, value: Feed) => digest({ ...scope, configuration: config(value) });
const invalid = () => new AdportError('PROVIDER_ERROR', 'TikTok feed response has an unexpected scope, identifier or shape. No request was retried.');
const secrets = (value: Feed): string[] => {
  const source = value.last_update_param;
  return [source?.uri, source?.username, source?.password].filter((item): item is string => typeof item === 'string' && item.length > 0);
};
const publicText = (text: string, value: Feed) => secrets(value).reduce((out, secret) => out.replaceAll(secret, '[redacted]'), text);
function publicFeed(scope: Selection, value: Feed) {
  const source = value.last_update_param;
  return {
    feed_id: value.feed_id, feed_name: publicText(value.feed_name, value), status: value.status ?? 'UNKNOWN', feed_type: value.feed_type ?? 'Not reported',
    region_codes: value.region_codes?.map(text => publicText(text, value)), override_fields: value.override_fields?.map(text => publicText(text, value)),
    source_origin: publicText(origin(source?.uri), value), source_configured: !!source?.uri,
    ...(source?.uri ? { source_fingerprint: digest(source.uri) } : {}), update_mode: source?.update_mode ?? 'Not reported',
    schedule: { timezone: source?.timezone ? publicText(source.timezone, value) : null, interval_type: source?.interval_type ?? null, interval_count: source?.interval_count ?? null, day_of_month: source?.day_of_month ?? null, hour: source?.hour ?? null, minute: source?.minute ?? null },
    number_of_products: value.number_of_products, next_update_time: value.next_update_time || null, configuration_hash: configurationHash(scope, value),
  };
}
function frequency(value: ReturnType<typeof publicFeed>): string {
  const s = value.schedule;
  if (!s.interval_type) return 'Not configured';
  const unit = { HOURLY: 'hour', DAILY: 'day', MONTHLY: 'month' }[s.interval_type];
  const every = s.interval_count === null ? `${s.interval_type.toLowerCase()} interval not reported` : `Every ${s.interval_count} ${unit}${s.interval_count === 1 ? '' : 's'}`;
  const time = s.hour === null || s.minute === null ? '' : `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
  return [every, s.interval_type === 'MONTHLY' && s.day_of_month !== null ? `day ${s.day_of_month}` : '', s.timezone, time].filter(Boolean).join(' · ');
}
const commonNotes = ['The catalog and its feeds may be reused by other ads or accounts. No campaign status or budget is changed.', 'Stored configuration is not proof of authenticated source access or successful product ingestion. Read the native processing log.', 'Native reads do not confirm authentication values; a configuration hash cannot detect password-only changes.', 'No automatic retry. Reconcile the known feed after an uncertain result.'];

/** Business Center catalog feeds. Native lists are unpaged and locally bounded. */
export class TikTokCatalogFeeds {
  constructor(private readonly client: Pick<TikTokClient, 'get' | 'post'>, private readonly authorizeParent: (input: Selection, write?: boolean) => Promise<Parent>) {}
  private async read(path: string, params: Record<string, unknown>): Promise<unknown> {
    try { return await this.client.get(path, params); }
    catch (error) {
      if (error instanceof AdportError && ['POLICY_VIOLATION', 'NOT_CONNECTED'].includes(error.code)) throw error;
      throw new AdportError('PROVIDER_ERROR', 'TikTok feed read failed. Check native catalog permissions. Provider bodies and source credentials are hidden; no request was retried.');
    }
  }
  private async native(scope: Selection, feedId?: string): Promise<Feed[]> {
    const parsed = z.object({ feed_list: z.array(feed).max(5000), bc_id: nativeId.optional(), catalog_id: nativeId.optional(), page_info: z.object({ page: count, total_page: count, total_number: count.optional() }).optional() }).safeParse(await this.read('catalog/feed/get', { bc_id: scope.bc_id, catalog_id: scope.catalog_id, ...(feedId ? { feed_id: feedId } : {}) }));
    if (!parsed.success) throw invalid();const data = parsed.data, rows = data.feed_list;
    if (data.bc_id !== undefined && data.bc_id !== scope.bc_id || data.catalog_id !== undefined && data.catalog_id !== scope.catalog_id || new Set(rows.map(row => row.feed_id)).size !== rows.length || rows.some(row => row.catalog_id !== undefined && row.catalog_id !== scope.catalog_id || row.bc_id !== undefined && row.bc_id !== scope.bc_id || feedId && row.feed_id !== feedId) || feedId && rows.length !== 1 || data.page_info && (data.page_info.page !== 1 || data.page_info.total_page > 1 || data.page_info.total_number !== undefined && data.page_info.total_number !== rows.length)) throw invalid();
    return rows;
  }
  async list(value: unknown) {
    const input = catalogFeedList.parse(value), scope = catalogInput.parse({ account_id: input.account_id, bc_id: input.bc_id, catalog_id: input.catalog_id });await this.authorizeParent(scope);
    const rows = (await this.native(scope, input.feed_id)).sort((a, b) => a.feed_id.localeCompare(b.feed_id)), snapshot = digest({ ...scope, feed_id: input.feed_id, page_size: input.page_size, feeds: rows.map(config) });let offset = 0;
    if (input.cursor) {
      let cursor;
      try { cursor = z.object({ offset: count.max(4999), snapshot: hash }).strict().parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); } catch { throw new AdportError('INVALID_INPUT', 'Invalid feed cursor. Refresh the first page.'); }
      if (cursor.snapshot !== snapshot || cursor.offset === 0 || cursor.offset >= rows.length || cursor.offset % input.page_size !== 0) throw new AdportError('INVALID_INPUT', 'Feed configuration or selection changed. Refresh the first page.');offset = cursor.offset;
    }
    const feeds = rows.slice(offset, offset + input.page_size).map(row => publicFeed(scope, row)), more = offset + feeds.length < rows.length;
    return { feeds, records: feeds.map(row => ({ id: row.feed_id, name: row.feed_name, status: row.status, type: row.feed_type, frequency: frequency(row), update_mode: row.update_mode, source: row.source_origin })), complete: !more, truncated: more, ...(more ? { next_cursor: Buffer.from(JSON.stringify({ offset: offset + feeds.length, snapshot })).toString('base64url') } : {}), notes: ['TikTok returns all catalog feeds; Adport bounds the list to 5,000 and pages a snapshot locally. Source paths, query values and authentication are hidden.', ...commonNotes.slice(1, 3)] };
  }
  async log(value: unknown) {
    const input = catalogFeedLog.parse(value), scope = catalogInput.parse({ account_id: input.account_id, bc_id: input.bc_id, catalog_id: input.catalog_id });await this.authorizeParent(scope);await this.native(scope, input.feed_id);
    const status = z.object({ add_count: count, error_count: count, remove_count: count, process_status: z.enum(['PROCESSING', 'SUCCESS', 'FAILED', 'WAITING']), update_count: count, warn_count: count });
    const time = z.object({ start_time: nativeTime.nullable().optional(), end_time: nativeTime.nullable().optional() });
    const entry = z.object({ update_status: status.optional(), last_update_status: status.optional(), update_time: time.optional(), last_update_time: time.optional() }).refine(row => !!(row.update_status ?? row.last_update_status) && !!(row.update_time ?? row.last_update_time) && (!row.update_status || !row.last_update_status || canonical(row.update_status) === canonical(row.last_update_status)) && (!row.update_time || !row.last_update_time || canonical(row.update_time) === canonical(row.last_update_time)));
    const parsed = z.object({ feed_logs: z.array(entry).max(10), feed_id: nativeId.optional(), bc_id: nativeId.optional(), catalog_id: nativeId.optional() }).safeParse(await this.read('catalog/feed/log', { bc_id: input.bc_id, catalog_id: input.catalog_id, feed_id: input.feed_id }));
    if (!parsed.success || parsed.data.feed_id !== undefined && parsed.data.feed_id !== input.feed_id || parsed.data.bc_id !== undefined && parsed.data.bc_id !== input.bc_id || parsed.data.catalog_id !== undefined && parsed.data.catalog_id !== input.catalog_id) throw invalid();
    const logs = parsed.data.feed_logs.map(row => ({ ...(row.update_status ?? row.last_update_status!), ...(row.update_time ?? row.last_update_time!) }));
    return { feed_id: input.feed_id, logs, records: logs.map((row, index) => ({ id: `${input.feed_id}:${index}:${digest(row)}`, name: row.start_time || `Feed operation ${index + 1}`, status: row.process_status, added: row.add_count, updated: row.update_count, removed: row.remove_count, errors: row.error_count, warnings: row.warn_count, completed_at: row.end_time })), complete: true, truncated: false, history_scope: 'latest_10_operations_only', more_history_available: null, notes: ['This endpoint returns up to the latest 10 feed operations, not full history. Native SUCCESS and product counts do not establish ad delivery eligibility.'] };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const kinds: Record<string, string> = { tiktok_create_catalog_feed: 'create', tiktok_update_catalog_feed: 'update', tiktok_set_catalog_feed_schedule_status: 'update', tiktok_delete_catalog_feed: 'remove' };
    if (op.provider !== 'tiktok' || !Object.hasOwn(kinds, op.tool) || op.kind !== kinds[op.tool]) throw new AdportError('INVALID_INPUT', 'TikTok feed operation/provider kind mismatch.');
    const create = op.tool === 'tiktok_create_catalog_feed', input = create ? catalogFeedCreate.parse(op.payload) : op.tool === 'tiktok_update_catalog_feed' ? catalogFeedUpdate.parse(op.payload) : op.tool === 'tiktok_set_catalog_feed_schedule_status' ? catalogFeedSwitch.parse(op.payload) : catalogFeedDelete.parse(op.payload);
    const scope = catalogInput.parse({ account_id: op.accountId, bc_id: input.bc_id, catalog_id: input.catalog_id }), parent = await this.authorizeParent(scope, true);
    const review = (title: string, subject: string, fields: ReviewField[], notes: string[]) => ({ provider: 'tiktok', accountId: scope.account_id, kind: op.kind, title, subject, fields: [{ label: 'Catalog', after: input.catalog_id }, ...fields], notices: notes });
    if ('expected_catalog_hash' in input) {
      if (input.expected_catalog_hash !== parent.configuration_hash) throw new AdportError('INVALID_INPUT', 'Catalog configuration changed. Read and review feed creation again.');
      if (input.feed_type === 'COUNTRY_FEED' && parent.catalog_conf.is_multi_country !== true) throw new AdportError('INVALID_INPUT', 'A country feed requires a verified multi-country catalog. Native existing-product eligibility is checked on apply.');
      const sourceSecrets = input.schedule_param ? [input.schedule_param.source.uri, input.schedule_param.source.username, input.schedule_param.source.password].filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
      const displayName = sourceSecrets.reduce((name, secret) => name.replaceAll(secret, '[redacted]'), input.feed_name);
      const fields: ReviewField[] = [{ label: 'Name', after: displayName }, { label: 'Update mode', after: input.update_mode }, ...(input.feed_type ? [{ label: 'Feed type', after: input.feed_type }] : []), ...scheduleFields(input.schedule_param)];
      const notes = [input.schedule_param ? 'Supplying a source schedule can start automatic native product processing immediately. OVERWRITE can remove products missing from the source.' : 'No source schedule is supplied. The created feed must remain OFF with no source URI.', 'Country feeds also require existing products; native eligibility is checked on apply.', ...commonNotes];
      return { summary: `Create TikTok catalog feed ${displayName}`, changes: fields.map(field => `+ ${field.label}: ${JSON.stringify(field.after)}`), coercions: [], budgetDeltas: [], notes, review: review('Create catalog feed', displayName, fields, notes), execute: async () => {
        const fresh = await this.authorizeParent(scope, true);if (fresh.configuration_hash !== input.expected_catalog_hash) throw new AdportError('INVALID_INPUT', 'Catalog changed before creating the feed. Review again.');let createdId: string | undefined;
        try {
          const body = { bc_id: input.bc_id, catalog_id: input.catalog_id, feed_name: input.feed_name, update_mode: input.update_mode, ...(input.feed_type ? { feed_type: input.feed_type } : {}), ...(input.schedule_param ? { schedule_param: input.schedule_param } : {}) };
          const receipt = z.object({ feed_id: nativeId }).parse(await this.client.post('catalog/feed/create', body));createdId = receipt.feed_id;
          const actual = (await this.native(scope, createdId))[0]!;
          if (actual.feed_name !== input.feed_name || input.feed_type && actual.feed_type !== input.feed_type || actual.last_update_param?.update_mode !== input.update_mode || input.schedule_param && !matchesSchedule(actual, input.schedule_param) || !input.schedule_param && (actual.status !== 'OFF' || !!actual.last_update_param?.uri)) throw new Error('Creation readback differs');return [createdId];
        } catch { throw new AdportError('PROVIDER_ERROR', 'TikTok feed creation outcome is unconfirmed. Inspect catalog feeds before another create; do not replay automatically.', createdId ? { resource_ids: [createdId] } : undefined); }
      } };
    }
    const current = (await this.native(scope, input.feed_id))[0]!, name = publicText(current.feed_name, current);
    if (input.expected_configuration_hash !== configurationHash(scope, current)) throw new AdportError('INVALID_INPUT', 'Feed configuration changed. Read and review it again.');
    let path: string, body: Record<string, unknown>, expected = config(current), fields: ReviewField[], notes: string[];
    if (op.tool === 'tiktok_delete_catalog_feed') {
      path = 'catalog/feed/delete';body = { bc_id: input.bc_id, catalog_id: input.catalog_id, feed_id: input.feed_id };fields = [{ label: 'Feed', before: name, after: 'Permanently deleted' }];notes = ['Permanently removes this shared feed. Review dependent catalog products and ads; no restoration or compensating write is automatic.', ...commonNotes];
    } else if (op.tool === 'tiktok_set_catalog_feed_schedule_status') {
      const targetStatus = catalogFeedSwitch.parse(input).status;
      if (!current.status || current.status === targetStatus) throw new AdportError('INVALID_INPUT', 'Schedule status must be known and change to the opposite ON/OFF value.');
      const source = current.last_update_param;if (targetStatus === 'ON' && (!source?.uri || !sourceUri.safeParse(source.uri).success || !source.interval_type || !source.timezone)) throw new AdportError('INVALID_INPUT', 'Enabling a feed requires a configured source URI, interval and time zone.');
      path = 'catalog/feed/switch';body = { bc_id: input.bc_id, catalog_id: input.catalog_id, feed_id: input.feed_id, status: targetStatus };expected = { ...expected, status: targetStatus };fields = [{ label: 'Automatic processing', before: current.status, after: targetStatus }, { label: 'Source', after: { origin: origin(source?.uri), fingerprint: source?.uri ? digest(source.uri) : 'Not configured' } }];notes = ['ON resumes automatic product processing and may change products selected by existing ads. OFF stops future scheduled runs; it does not undo previous imports.', ...commonNotes];
    } else {
      const update = catalogFeedUpdate.parse(input);path = 'catalog/feed/update';body = { bc_id: input.bc_id, catalog_id: input.catalog_id, feed_id: input.feed_id, update_mode: update.update_mode, ...(update.schedule_param ? { schedule_param: update.schedule_param } : {}) };
      expected = { ...expected, schedule: { ...expected.schedule, update_mode: update.update_mode } };
      if (update.schedule_param) expected.schedule = { ...expected.schedule, ...scheduleConfig({ ...update.schedule_param, uri: update.schedule_param.source.uri, update_mode: update.update_mode }) };
      fields = [{ label: 'Update mode', before: current.last_update_param?.update_mode ?? 'Not reported', after: update.update_mode }, ...scheduleFields(update.schedule_param, current)];notes = ['Replaces the supplied source/schedule configuration. Existing automatic runs can use it immediately; OVERWRITE can remove products missing from the source.', 'Supply any required source authentication explicitly when replacing the schedule. Native credential values are unavailable for preservation/readback.', ...commonNotes];
    }
    const remove = op.kind === 'remove', title = remove ? 'Delete catalog feed' : 'status' in input ? 'Change feed schedule status' : 'Update catalog feed';
    return { summary: `${title} ${name}`, changes: fields.map(field => `${remove ? '-' : '~'} ${field.label}: ${JSON.stringify(field.after)}`), coercions: [], budgetDeltas: [], notes, review: review(title, name, fields, notes), execute: async () => {
      await this.authorizeParent(scope, true);
      try {
        const raw = await this.client.post(path, body);
        if (path === 'catalog/feed/switch') { const receipt = z.object({ feed_id: nativeId.optional() }).parse(raw);if (receipt.feed_id !== undefined && receipt.feed_id !== input.feed_id) throw new Error('Feed ID differs'); }
        else if (z.object({ feed_id: nativeId }).parse(raw).feed_id !== input.feed_id) throw new Error('Feed ID differs');
        if (remove) { if ((await this.native(scope)).some(row => row.feed_id === input.feed_id)) throw new Error('Deleted feed remains'); }
        else if (canonical(config((await this.native(scope, input.feed_id))[0]!)) !== canonical(expected)) throw new Error('Configuration preservation differs');
        return [input.feed_id];
      } catch { throw new AdportError('PROVIDER_ERROR', 'TikTok feed mutation outcome is unconfirmed. Read the known feed/catalog before another write; do not replay automatically.', { resource_ids: [input.feed_id] }); }
    } };
  }
}
function scheduleFields(value: z.infer<typeof schedule> | undefined, before?: Feed): ReviewField[] {
  const current = before?.last_update_param;
  return value ? [
    { label: 'Source', ...(before ? { before: { origin: origin(current?.uri), fingerprint: current?.uri ? digest(current.uri) : 'Not configured' } } : {}), after: { origin: origin(value.source.uri), fingerprint: digest(value.source.uri) } },
    { label: 'Source authentication', ...(before ? { before: 'Native values are not readable' } : {}), after: value.source.username || value.source.password ? 'Supplied; values hidden' : 'Not supplied' },
    { label: 'Schedule', ...(before ? { before: { interval_type: current?.interval_type, interval_count: current?.interval_count, timezone: current?.timezone ? publicText(current.timezone, before) : null, day_of_month: current?.day_of_month, hour: current?.hour, minute: current?.minute } } : {}), after: { interval_type: value.interval_type, interval_count: value.interval_count, timezone: value.timezone, day_of_month: value.day_of_month, hour: value.hour, minute: value.minute } },
  ] : [{ label: 'Source schedule', after: before ? 'Preserve current schedule' : 'Not supplied' }];
}
function matchesSchedule(actual: Feed, wanted: z.infer<typeof schedule>) {
  const current = actual.last_update_param;
  return current?.uri === wanted.source.uri && current.timezone === wanted.timezone && current.interval_type === wanted.interval_type && current.interval_count === wanted.interval_count && current.hour === wanted.hour && current.minute === wanted.minute && (wanted.day_of_month === undefined || current.day_of_month === wanted.day_of_month);
}
