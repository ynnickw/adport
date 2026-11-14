import { createHash } from 'node:crypto';
import { AdportError, type ReviewField, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import type { RedditAdsClient } from './client.js';
import type { RedditCatalogService } from './catalogs.js';
import { redditCatalogId } from './catalog-access.js';
import { catalogInput } from './catalog-schemas.js';
import { feedInput, feedList, feedCreate, feedUpdate, feedStatus, feedDelete, feedSchedule, feedMode } from './catalog-feed-schemas.js';

type Scope = z.infer<typeof catalogInput>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<WriteResult> };
const nativeSchedule = z.object({ is_paused: z.boolean().nullable().optional(), interval: z.enum(['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY']).nullable().optional(), interval_count: z.number().int().positive().safe().nullable().optional(), day_of_month: z.number().int().min(1).max(31).nullable().optional(), day_of_week: z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']).nullable().optional(), hour: z.number().int().min(0).max(23).nullable().optional(), minute: z.number().int().min(0).max(59).nullable().optional(), timezone: z.string().max(128).nullable().optional(), next_import_at: z.iso.datetime({ offset: true }).nullable().optional() }).strict();
const feedRow = z.object({ id: redditCatalogId, catalog_id: redditCatalogId, name: z.string().min(1).max(4000).nullable().optional(), url: z.string().min(1).max(8192), mode: feedMode, schedule: nativeSchedule.nullable().optional(), username: z.string().max(100).nullable().optional(), password: z.string().max(100).nullable().optional() });
type Feed = z.infer<typeof feedRow>;
const scope = (input: Scope): Scope => ({ account_id: input.account_id, business_id: input.business_id, catalog_id: input.catalog_id });
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function scheduleConfig(value: Feed['schedule']) {
  if (value === null || value === undefined) return value;
  const { next_import_at: _volatile, ...config } = value;return { ...config, day_of_month: config.day_of_month ?? null, day_of_week: config.day_of_week ?? null };
}
const config = (row: Feed) => ({ id: row.id, catalog_id: row.catalog_id, name: row.name, url: row.url, mode: row.mode, schedule: scheduleConfig(row.schedule) });
const configurationHash = (input: Scope, row: Feed) => digest({ ...scope(input), configuration: config(row) });
const origin = (value: string) => { try { const url = new URL(value);return url.protocol + '//' + url.host; } catch { return 'Unavailable'; } };
function secrets(row?: Pick<Feed, 'url' | 'username' | 'password'>) {
  if (!row) return [];const values = [row.url, row.username, row.password].filter((value): value is string => typeof value === 'string' && value.length > 0);
  try { const url = new URL(row.url);for (const value of url.searchParams.values()) if (value) values.push(value);for (const entry of url.search.slice(1).split('&')) { const value = entry.slice(entry.indexOf('=') + 1);if (entry.includes('=') && value) values.push(value); } } catch { /* Unreadable native sources still remain private. */ }
  return values;
}
function redact(text: string, values: string[]) {
  const alternatives = [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length).map(value => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'));
  return alternatives.length ? text.replace(new RegExp(alternatives.join('|'), 'g'), '[redacted]') : text;
}
function publicValue(value: unknown, privateValues: string[]): unknown {
  if (typeof value === 'string') return redact(value, privateValues);
  if (Array.isArray(value)) return value.map(item => publicValue(item, privateValues));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicValue(item, privateValues)]));
  return value;
}
function publicFeed(input: Scope, row: Feed) {
  const privateValues = secrets(row);
  return { feed_id: row.id, catalog_id: row.catalog_id, name: row.name == null ? row.name : redact(row.name, privateValues), mode: row.mode, source_origin: redact(origin(row.url), privateValues), source_fingerprint: digest(row.url), schedule: row.schedule === undefined ? undefined : row.schedule === null ? null : { ...scheduleConfig(row.schedule), timezone: row.schedule.timezone == null ? row.schedule.timezone : redact(row.schedule.timezone, privateValues), next_import_at: row.schedule.next_import_at }, configuration_hash: configurationHash(input, row), authentication_values_reported: false };
}
const notes = ['This shared feed can change products used by existing ads. No ads, spend or conversion events are submitted by this operation.', 'Choose native REPLACE or UPDATE explicitly. Feed processing can change shared catalog products; native import results and downstream effects require separate inspection.', 'Source URLs/authentication are private in tool results and widget approval metadata. Source, authentication and name changes must be applied by the agent with the identical arguments.', 'Authentication values are not independently verified by native reads. Configuration hashes exclude them and cannot detect authentication-only changes.', 'Source lifetime and successful ingestion are not established by configuration readback. A short-lived private upload URL is unsuitable for an ongoing recurring feed.', 'Source fingerprints identify the URL, not immutable feed bytes. Approval binds the URL/configuration; remote source contents can change between imports.', 'Never replay a native write automatically. Reconcile known IDs after uncertain mutation or readback.'];
const invalid = () => new AdportError('PROVIDER_ERROR', 'Reddit feed identifier, catalog scope or native configuration could not be verified.');
function failure(error: unknown, message: string, ids?: string[]) { const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};return new AdportError('PROVIDER_ERROR', message + ' Provider bodies and source credentials stay hidden; no mutation was retried.', { ...(Number.isInteger(details.http_status) ? { http_status: details.http_status } : {}), ...(ids ? { resourceIds: ids } : {}) }); }
function knownSchedule(value: Feed['schedule']) {
  if (value === null) return null;if (value === undefined) throw new AdportError('PROVIDER_ERROR', 'Current feed schedule is unavailable; preservation cannot be verified.');
  const parsed = feedSchedule.safeParse(scheduleConfig(value));if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'Current feed schedule is incomplete or unsupported; read native configuration before changing it.');return parsed.data;
}

/** Native unpaged feeds with exact catalog grants and private source handling. */
export class RedditCatalogFeeds {
  constructor(private readonly client: Pick<RedditAdsClient, 'get' | 'post' | 'patch' | 'delete'>, private readonly catalogs: RedditCatalogService) {}
  private async native(input: Scope, id?: string, absent = false) {
    const path = id ? 'product_feeds/' + encodeURIComponent(id) : 'product_catalogs/' + encodeURIComponent(input.catalog_id) + '/product_feeds';let response;
    try { response = await this.client.get<unknown>(path); } catch (error) { if (absent && error instanceof AdportError && (error.details as Record<string, unknown> | undefined)?.http_status === 404) return [];throw failure(error, 'Reddit catalog feed read failed.'); }
    const parsed = (id ? feedRow.transform(value => [value]) : z.array(feedRow).max(5000)).safeParse(response.data);
    if (!parsed.success || response.pagination?.next_url || parsed.data.some(row => row.catalog_id !== input.catalog_id || id && row.id !== id) || new Set(parsed.data.map(row => row.id)).size !== parsed.data.length) throw invalid();return parsed.data;
  }
  async list(value: unknown) {
    const input = feedList.parse(value);await this.catalogs.authorize(scope(input));const rows = (await this.native(input)).sort((a, b) => a.id.localeCompare(b.id)), snapshot = digest({ ...scope(input), page_size: input.page_size, feeds: rows.map(config) });let offset = 0;
    if (input.cursor) { let parsed;try { parsed = z.object({ offset: z.number().int().positive().max(4999), snapshot: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); } catch { throw new AdportError('INVALID_INPUT', 'Invalid feed cursor; refresh the first page.'); }if (parsed.snapshot !== snapshot || parsed.offset >= rows.length || parsed.offset % input.page_size !== 0) throw new AdportError('PENDING_MISMATCH', 'Feed configuration or selection changed; refresh the first page.');offset = parsed.offset; }
    const feeds = rows.slice(offset, offset + input.page_size).map(row => publicFeed(input, row)), more = offset + feeds.length < rows.length;
    return { feeds, records: feeds.map(row => ({ id: row.feed_id, name: row.name ?? 'Feed ' + row.feed_id, mode: row.mode, source: row.source_origin, schedule: row.schedule === undefined ? 'Unavailable' : row.schedule === null ? 'No recurring schedule' : row.schedule.is_paused === true ? 'Paused' : row.schedule.is_paused === false ? 'Running' : 'Unavailable' })), complete: !more, truncated: more, ...(more ? { next_cursor: Buffer.from(JSON.stringify({ offset: offset + feeds.length, snapshot })).toString('base64url') } : {}), notes: ['Native feed lists are unpaged. Adport bounds them to 5,000 and pages a configuration snapshot locally; this is not a product inventory.', ...notes.slice(2, 5)] };
  }
  async get(value: unknown) { const input = feedInput.parse(value);await this.catalogs.authorize(scope(input));const feed = publicFeed(input, (await this.native(input, input.feed_id))[0]!);return { feed, records: [{ id: feed.feed_id, name: feed.name ?? 'Feed ' + feed.feed_id, mode: feed.mode, source: feed.source_origin }], complete: true, truncated: false, notes: notes.slice(2, 5) }; }
  async plan(op: WriteOperation): Promise<Plan> {
    const create = op.tool === 'reddit_create_catalog_feed', update = op.tool === 'reddit_update_catalog_feed', toggle = op.tool === 'reddit_set_catalog_feed_schedule_status', remove = op.tool === 'reddit_delete_catalog_feed';
    if (op.provider !== 'reddit' || !(create && op.kind === 'create' || (update || toggle) && op.kind === 'update' || remove && op.kind === 'remove')) throw new AdportError('INVALID_INPUT', 'Reddit feed operation/provider kind mismatch.');
    const input = create ? feedCreate.parse(op.payload) : update ? feedUpdate.parse(op.payload) : toggle ? feedStatus.parse(op.payload) : feedDelete.parse(op.payload), selected = { account_id: op.accountId, business_id: input.business_id, catalog_id: input.catalog_id };
    const prepare = async () => {
      const parent = await this.catalogs.authorize(selected, true);
      if ('expected_catalog_configuration_hash' in input) { if (parent.configuration_hash !== input.expected_catalog_configuration_hash) throw new AdportError('PENDING_MISMATCH', 'Catalog configuration changed; read and preview again.');return; }
      const current = (await this.native(selected, input.feed_id))[0]!;if (configurationHash(selected, current) !== input.expected_configuration_hash) throw new AdportError('PENDING_MISMATCH', 'Feed configuration changed; read and preview again.');
      if (!remove) { const schedule = knownSchedule(current.schedule);if ('is_paused' in input && (schedule === null || schedule.is_paused === input.is_paused)) throw new AdportError('INVALID_INPUT', 'A configured schedule must change to its opposite pause state.'); }
      return current;
    };
    const before = await prepare(), data: Record<string, unknown> = {};
    const writable = new Set(['name', 'url', 'mode', 'schedule', 'username', 'password']);
    for (const [key, value] of Object.entries(input)) if (writable.has(key) && value !== undefined) data[key] = value;
    if ('is_paused' in input) data.schedule = { ...knownSchedule(before!.schedule)!, is_paused: input.is_paused };
    const privateValues = [...secrets(before), ...secrets({ url: 'url' in input ? input.url ?? '' : '', username: 'username' in input ? input.username : undefined, password: 'password' in input ? input.password : undefined })], display = (value: string) => redact(value, privateValues), fields: ReviewField[] = [{ label: 'Catalog', after: input.catalog_id }, { label: 'Business', after: input.business_id }];
    if (before) fields.push({ label: 'Feed', after: before.id });
    if ('name' in data) fields.push({ label: 'Name', before: before?.name == null ? before?.name : display(before.name), after: data.name === null ? 'Cleared' : display(String(data.name)) });
    if ('url' in data) fields.push({ label: 'Source', ...(before ? { before: { origin: display(origin(before.url)), fingerprint: digest(before.url) } } : {}), after: { origin: display(origin(String(data.url))), fingerprint: digest(String(data.url)) } });
    if ('mode' in data) fields.push({ label: 'Product processing', ...(before ? { before: before.mode } : {}), after: data.mode });
    if ('username' in data || 'password' in data) fields.push({ label: 'Source authentication', after: { username: 'username' in data ? data.username === null ? 'Cleared' : 'Supplied; hidden' : 'Preserved', password: 'password' in data ? data.password === null ? 'Cleared' : 'Supplied; hidden' : 'Preserved' } });
    if ('schedule' in data) fields.push({ label: 'Schedule', ...(before ? { before: scheduleConfig(before.schedule) } : {}), after: data.schedule === null ? 'No recurring schedule' : data.schedule });
    if (remove) fields.push({ label: 'Feed removed', before: before!.name == null ? 'Feed ' + before!.id : display(before!.name), after: 'Permanently deleted' });
    const title = create ? 'Create catalog feed' : remove ? 'Delete catalog feed permanently' : toggle ? 'Change feed schedule status' : 'Update catalog feed', subject = 'name' in input && typeof input.name === 'string' ? display(input.name) : before?.name == null ? create ? 'New catalog feed' : 'Feed ' + before!.id : display(before.name), safeFields = publicValue(fields, privateValues) as ReviewField[];
    const notices = [notes[0]!];
    if (remove) notices.push('Permanently removes the shared feed definition. Imported products and dependent ads are not enumerated or frozen; their effects require separate inspection.', 'No restore or automatic write replay is available. Reconcile the known feed after an uncertain result.');
    else if (toggle) notices.push('Pausing controls future scheduling; this does not certify cancellation or reversal of an existing import.');
    else {
      if (['url', 'mode', 'schedule', 'username', 'password'].some(key => key in data)) notices.push('The selected changes may start native product processing immediately. Configuration readback does not certify source authentication, successful ingestion or product retention.');
      if (['url', 'name', 'username', 'password'].some(key => key in data)) notices.push('Private source/name arguments stay with the agent. Review in chat, then ask it to apply the identical arguments.');
      if ('url' in data) notices.push('The fingerprint identifies the URL, not immutable feed bytes. The source can change between imports and must remain available for its intended schedule.');
    }
    return { summary: title + ' · ' + subject, changes: safeFields.map(field => (remove ? '- ' : create ? '+ ' : '~ ') + field.label + ': ' + canonical(field.after)), coercions: [], budgetDeltas: [], notes: notices,
      review: { provider: 'reddit', accountId: op.accountId, kind: op.kind, title, subject, fields: safeFields, notices },
      execute: async () => { const fresh = await prepare();let id = before?.id;try {
        if (remove) { const receipt = await this.client.delete<unknown>('product_feeds/' + encodeURIComponent(id!));if (!receipt.data || typeof receipt.data !== 'object' || Array.isArray(receipt.data)) throw invalid();await this.catalogs.authorize(selected, true);if ((await this.native(selected, id, true)).length) throw invalid(); }
        else {
          const raw = create ? (await this.client.post<unknown>('product_catalogs/' + encodeURIComponent(input.catalog_id) + '/product_feeds', { data })).data : (await this.client.patch<unknown>('product_feeds/' + encodeURIComponent(id!), { data })).data, known = z.object({ id: redditCatalogId }).safeParse(raw);if (create && known.success) id = known.data.id;
          const receipt = feedRow.safeParse(raw);if (!receipt.success || receipt.data.id !== id || receipt.data.catalog_id !== input.catalog_id) throw invalid();await this.catalogs.authorize(selected, true);const actual = (await this.native(selected, id))[0]!;
          const expected = create ? { id: id!, catalog_id: input.catalog_id, name: 'name' in data ? data.name : actual.name, url: data.url, mode: data.mode, schedule: data.schedule } : { ...fresh!, ...data };
          if (canonical(config(actual)) !== canonical(config(feedRow.parse(expected)))) throw invalid();
        }
        return { applied: true, resourceIds: [id!], ...('username' in data || 'password' in data ? { details: { authentication_readback_verified: false }, warnings: ['Native configuration was read back; source authentication and ingestion success were not independently verified.'] } : {}) };
      } catch (error) { throw failure(error, 'Reddit feed mutation or independent configuration/absence readback is unconfirmed. Reconcile known IDs before another write.', id ? [id] : undefined); } } };
  }
}
