import { createHash } from 'node:crypto';
import { AdportError, type Creative, type ReviewField, type WriteGuard, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import type { XParams } from './client.js';
import type { XCreativeService } from './creatives.js';
import type { XAdsEntities } from './entities.js';
import type { XPostService } from './posts.js';
import { xId } from './schemas.js';
import { snowflake } from './creative-tools.js';
import { createScheduled, createScheduledPromotion, deleteScheduled, deleteScheduledPromotion, nativeScheduled, nativeScheduledPromotion, scheduledFields, scheduledList, scheduledPromotionList, scheduledPromotionSelection, updateScheduled, type ScheduledPost, type ScheduledPromotion } from './scheduled-schemas.js';

interface Plan extends Omit<WritePreview, 'serverValidated'> { execute(): Promise<string[] | WriteResult> }
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
const equal = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const config = (post: ScheduledPost) => { const { completed_at: _completed, ...rest } = post;return { ...rest, scheduled_at: new Date(post.scheduled_at).toISOString() }; };
const sourceConfig = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !['created_at', 'updated_at', 'media_url', 'poster_media_url'].includes(key)));
const pageSchema = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item).max(1000), next_cursor: z.string().min(1).max(4096).nullable().optional() });
const notices = ['X publishes this promoted-only post automatically at its scheduled time. No parent delivery setting is changed.', 'Previews are local plans, not native validation. Scheduling, publication, ad association and actual delivery are separate states. No write is retried automatically.'];

/** Official xdevplatform/docs creatives a9226e10 and campaign-management570f918c, checked2026-11-06. */
export class XScheduledService {
  constructor(private readonly entities: XAdsEntities, private readonly creatives: XCreativeService, private readonly posts: XPostService) {}
  private base(account: string) { return `accounts/${xId.parse(account)}`; }
  private async author(account: string, user: string) {
    snowflake.parse(user);
    const matches = (await this.creatives.users(account)).filter(row => row.user_id === user && !row.deleted);
    if (matches.length !== 1 || !['FULL', 'RETWEETS_ONLY'].includes(matches[0]!.promotable_user_type)) throw new AdportError('INVALID_INPUT', 'x: schedule author must be an unambiguous current account-associated user');
    return matches[0]!;
  }
  private scoped(account: string, row: ScheduledPost, user?: string) {
    if (row.account_id !== undefined && row.account_id !== account || user !== undefined && row.user_id !== user) throw new AdportError('PROVIDER_ERROR', 'x: scheduled-post account/author mismatch');
    return row;
  }
  private paging(ids: string[], next: string | null | undefined, previous?: string) {
    if (new Set(ids).size !== ids.length || next && next === previous) throw new AdportError('PROVIDER_ERROR', 'x: scheduled pagination repeated an ID or cursor');
    return { truncated: next !== null, ...(next ? { next_cursor: next } : {}), ...(next === undefined ? { notes: ['Native continuation marker is missing; completeness is unconfirmed.'] } : {}) };
  }
  private async raw(account: string, id: string, user?: string) {
    const row = (await this.entities.client.request('GET', `${this.base(account)}/scheduled_tweets/${snowflake.parse(id)}`, z.object({ data: nativeScheduled }))).data;
    if (row.id !== id) throw new AdportError('PROVIDER_ERROR', 'x: scheduled-post ID mismatch');
    return this.scoped(account, row, user);
  }
  private async promotionPage(account: string, params: XParams, line?: string) {
    const result = await this.entities.client.request('GET', `${this.base(account)}/scheduled_promoted_tweets`, pageSchema(nativeScheduledPromotion), { ...params, ...(line ? { line_item_ids: line } : {}) });
    if (result.data.some(row => row.account_id !== undefined && row.account_id !== account || line && row.line_item_id !== line)) throw new AdportError('PROVIDER_ERROR', 'x: scheduled-ad account/parent mismatch');
    this.paging(result.data.map(row => row.id), result.next_cursor, typeof params.cursor === 'string' ? params.cursor : undefined);return result;
  }
  private async associations(account: string, scheduledId: string) {
    const rows: ScheduledPromotion[] = [], ids = new Set<string>(), cursors = new Set<string>();let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.promotionPage(account, { count: 200, with_deleted: false, ...(cursor ? { cursor } : {}) });
      for (const row of result.data) { if (row.deleted || ids.has(row.id)) throw new AdportError('PROVIDER_ERROR', 'x: scheduled-ad inventory contains deleted/duplicate rows');ids.add(row.id);if (row.scheduled_tweet_id === scheduledId) rows.push(row); }
      if (result.next_cursor === null) return rows.sort((a, b) => a.id.localeCompare(b.id));
      if (!result.next_cursor || cursors.has(result.next_cursor)) break;
      cursor = result.next_cursor;cursors.add(cursor);
    }
    throw new AdportError('INVALID_INPUT', 'x: scheduled-ad inventory is incomplete; cannot prepare a safe mutation');
  }
  async get(account: string, user: string, id: string) {
    const author = await this.author(account, user), post = await this.raw(account, id, user), associations = await this.associations(account, id);
    return { ...post, associations, snapshot_hash: hash({ account, author: sourceConfig(author), post: config(post), associations }) };
  }
  private mutable(post: ScheduledPost) {
    if (post.scheduled_status !== 'SCHEDULED' || post.tweet_id !== null || post.completed_at || !post.nullcast || Date.parse(post.scheduled_at) <= Date.now()) throw new AdportError('INVALID_INPUT', 'x: this mutation requires a still-future promoted-only SCHEDULED post; inspect published posts/ads after publication');
  }
  private schedule(time: string) {
    const now = Date.now(), last = new Date(now);last.setUTCFullYear(last.getUTCFullYear() + 1);
    if (Date.parse(time) < now + 15 * 60_000 || Date.parse(time) > last.getTime()) throw new AdportError('INVALID_INPUT', 'x: choose a UTC minute at least15minutes and at most one calendar year ahead');
  }
  private async visualMedia(account: string, rows: ScheduledPost[], include: boolean) {
    const keys = include ? [...new Set(rows.flatMap(row => row.media_keys))] : [], values = new Map<string, Creative['media']>();
    // Bound fan-out independently of the native page size. Remaining copy is still shown.
    const pending = keys.slice(0, 40);let index = 0, failed = 0;
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => { while (index < pending.length) { const key = pending[index++]!;try { const media = await this.creatives.media(account, key);if (!media.deleted) values.set(key, this.creatives.visual(media)); } catch { failed++; } } }));
    return { values, notes: [...(keys.length > 40 ? ['Media previews are limited to40unique library items per page. Use a smaller page for remaining previews.'] : []), ...(failed ? ['Some native media previews are unavailable; schedule copy and IDs are preserved.'] : [])] };
  }
  async list(value: z.input<typeof scheduledList>) {
    const input = scheduledList.parse(value);await this.author(input.account_id, input.user_id);
    const result = await this.entities.client.request('GET', `${this.base(input.account_id)}/scheduled_tweets`, pageSchema(nativeScheduled), { user_id: input.user_id, count: input.count, ...(input.cursor ? { cursor: input.cursor } : {}) });
    result.data.forEach(row => this.scoped(input.account_id, row, input.user_id));const page = this.paging(result.data.map(row => row.id), result.next_cursor, input.cursor), media = await this.visualMedia(input.account_id, result.data, input.include_media);
    const creatives: Creative[] = result.data.map(row => ({ id: row.id, provider: 'x', account_id: input.account_id, name: row.name ?? `Scheduled post ${row.id}`, type: row.nullcast ? 'SCHEDULED_PROMOTED_ONLY_POST' : 'SCHEDULED_ORGANIC_POST', status: row.scheduled_status, headlines: [], descriptions: [row.text, `Scheduled: ${row.scheduled_at}`, ...(row.tweet_id ? [`Published post: ${row.tweet_id}`] : [])], landing_urls: [], media: row.media_keys.flatMap(key => media.values.get(key) ?? []), actions: [] }));
    return { account_id: input.account_id, items: result.data, creatives, ...page, notes: [...(page.notes ?? []), ...media.notes] };
  }
  async creationContext(account: string, value: z.input<typeof scheduledFields>) {
    const input = scheduledFields.parse(value);this.schedule(input.scheduled_at);const author = await this.author(account, input.as_user_id), actor = await this.creatives.verifyComposer(account, input.as_user_id), sources = await this.creatives.verifyAttachments(account, input.media_keys ?? [], input.card_uri);
    return { context_hash: hash({ account, input, author: sourceConfig(author), actor, media: sources.media.map(sourceConfig), cards: sources.cards.map(sourceConfig) }), request: input, nullcast: true, ad_association_created: false, notes: notices };
  }
  async promotions(value: z.input<typeof scheduledPromotionList>) {
    const input = scheduledPromotionList.parse(value);await this.posts.parents(input.account_id, input.line_item_id);
    const result = await this.promotionPage(input.account_id, { count: input.count, with_deleted: input.with_deleted, ...(input.cursor ? { cursor: input.cursor } : {}) }, input.line_item_id);
    if (!input.with_deleted && result.data.some(row => row.deleted)) throw new AdportError('PROVIDER_ERROR', 'x: scheduled-ad filter returned deleted rows');
    return { account_id: input.account_id, line_item_id: input.line_item_id, items: result.data, records: result.data, ...this.paging(result.data.map(row => row.id), result.next_cursor, input.cursor) };
  }
  async getPromotion(account: string, id: string) {
    const row = (await this.entities.client.request('GET', `${this.base(account)}/scheduled_promoted_tweets/${xId.parse(id)}`, z.object({ data: nativeScheduledPromotion }), { with_deleted: true })).data;
    if (row.id !== id || row.account_id !== undefined && row.account_id !== account) throw new AdportError('PROVIDER_ERROR', 'x: scheduled-ad ID/account mismatch');
    const parent = await this.posts.parents(account, row.line_item_id);
    // A deleted schedule is a hard404. Tombstone readback does not require its source.
    const source = row.deleted ? null : await this.raw(account, row.scheduled_tweet_id);
    if (source) await this.author(account, source.user_id);
    return { ...row, source, parent: parent.snapshot, context_hash: hash({ account, row, source: source ? config(source) : null, parent: parent.snapshot }) };
  }
  async promotionContext(account: string, value: z.input<typeof scheduledPromotionSelection>) {
    const input = scheduledPromotionSelection.parse(value), post = await this.get(account, input.user_id, input.scheduled_tweet_id);await this.creatives.verifyComposer(account, input.user_id);this.mutable(post);
    const parent = await this.posts.parents(account, input.line_item_id);
    if (parent.line.deleted || parent.campaign.deleted || !['ACTIVE', 'PAUSED'].includes(parent.line.entity_status) || !['ACTIVE', 'PAUSED'].includes(parent.campaign.entity_status) || !['PROMOTED_TWEETS', 'PROMOTED_ACCOUNT'].includes(parent.line.product_type)) throw new AdportError('INVALID_INPUT', 'x: scheduled promotion requires supported existing non-draft parents');
    const existing = post.associations.filter(row => row.line_item_id === input.line_item_id);
    return { context_hash: hash({ account, input, post, parent: parent.snapshot, existing }), post, parent: parent.snapshot, existing, notes: [...notices, 'Native scheduled associations have no status field or PUT pause. They can promote after publication when parent settings allow.'] };
  }
  private unconfirmed(error: unknown, ids: string[]): never {
    const details = error instanceof AdportError ? error.details as Record<string, unknown> | undefined : undefined;
    const known = Array.isArray(details?.resource_ids) ? details.resource_ids.filter((value): value is string => typeof value === 'string') : [];
    throw new AdportError('PROVIDER_ERROR', 'x: scheduled write outcome was not confirmed. Reconcile known IDs and current inventory; do not replay the mutation.', { resource_ids: [...new Set([...ids, ...known])] });
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const account = xId.parse(op.accountId), kind = op.tool.startsWith('x_create_') ? 'create' : op.tool.startsWith('x_delete_') ? 'remove' : 'update';
    if (op.provider !== 'x' || op.kind !== kind) throw new AdportError('INVALID_INPUT', 'x: scheduled operation provider/kind mismatch');
    const review = (title: string, fields: ReviewField[], notes = notices): Omit<Plan, 'execute'> => ({ summary: title, changes: fields.map(field => `${field.label}: ${JSON.stringify(field.after)}`), coercions: [], budgetDeltas: [], notes, review: { provider: 'x', accountId: account, kind, title, fields, notices: notes } });
    if (op.tool === 'x_create_scheduled_post') {
      const { expected_context_hash, acknowledge_automatic_publication: _ack, ...input } = createScheduled.parse(op.payload), context = await this.creationContext(account, input);
      if (context.context_hash !== expected_context_hash) throw new AdportError('INVALID_INPUT', 'x: schedule source context changed; read and preview again');
      const wanted = { user_id: input.as_user_id, text: input.text ?? '', name: input.name ?? null, scheduled_at: input.scheduled_at, media_keys: input.media_keys ?? [], card_uri: input.card_uri ?? null, nullcast: true, scheduled_status: 'SCHEDULED', tweet_id: null };
      const params: XParams = { ...Object.fromEntries(Object.entries(input).filter(([key, v]) => key !== 'media_keys' && v !== undefined)), ...(input.media_keys?.length ? { media_keys: input.media_keys.join(',') } : {}), nullcast: true };
      return { ...review('Schedule promoted-only post', [{ label: 'Author', after: input.as_user_id }, { label: 'Publish automatically at', after: input.scheduled_at }, { label: 'Copy', after: wanted.text }, { label: 'Name', after: wanted.name }, { label: 'Media', after: wanted.media_keys }, { label: 'Card', after: wanted.card_uri }, { label: 'Publication', after: 'SCHEDULED · promoted-only · no ad association' }]), execute: async () => {
        const known: string[] = [];
        try {
          const row = (await this.entities.client.request('POST', `${this.base(account)}/scheduled_tweets`, z.object({ data: nativeScheduled }), params)).data;known.push(row.id);this.scoped(account, row, input.as_user_id);
          const observed = await this.raw(account, row.id, input.as_user_id);
          for (const value of [row, observed]) if (!Object.entries(wanted).every(([key, v]) => key === 'scheduled_at' ? Date.parse(value.scheduled_at) === Date.parse(String(v)) : equal(value[key as keyof ScheduledPost], v))) throw new Error('schedule receipt/readback mismatch');
          return { applied: true, resourceIds: known, details: { scheduled_status: 'SCHEDULED', nullcast: true, scheduled_at: observed.scheduled_at, published_tweet_id: null, ad_association_created: false } };
        } catch (error) { return this.unconfirmed(error, known); }
      } };
    }
    if (op.tool === 'x_update_scheduled_post' || op.tool === 'x_delete_scheduled_post') {
      const input = op.tool === 'x_update_scheduled_post' ? updateScheduled.parse(op.payload) : deleteScheduled.parse(op.payload), current = await this.get(account, input.user_id, input.scheduled_tweet_id);
      if (current.snapshot_hash !== input.expected_snapshot_hash) throw new AdportError('INVALID_INPUT', 'x: schedule snapshot changed; read and preview again');
      await this.creatives.verifyComposer(account, input.user_id);this.mutable(current);
      if (op.tool === 'x_delete_scheduled_post') {
        if (current.associations.length) throw new AdportError('INVALID_INPUT', 'x: remove live scheduled ad associations before deleting their source schedule');
        return { ...review('Permanently delete scheduled post', [{ label: 'Scheduled post', after: current.id }, { label: 'Copy', before: current.text, after: '(deleted)' }, { label: 'Automatic publication', before: current.scheduled_at, after: 'Cancelled' }], ['Hard deletion cannot be undone. The schedule must remain unpublished and have no live scheduled ad associations. Existing published posts/media are separate.', notices[1]!]), execute: async () => {
          const known = [current.id];
          try {
            const receipt = (await this.entities.client.request('DELETE', `${this.base(account)}/scheduled_tweets/${current.id}`, z.object({ data: nativeScheduled }))).data;
            known.push(receipt.id);
            if (!equal(config(receipt), { ...config(nativeScheduled.parse(current)), scheduled_status: 'DELETED' })) throw new Error('deletion receipt mismatch');
            try { await this.raw(account, current.id, input.user_id);throw new Error('deleted schedule still exists'); } catch (error) { if (!(error instanceof AdportError && (error.details as Record<string, unknown> | undefined)?.http_status === 404)) throw error; }
            return [current.id];
          } catch (error) { return this.unconfirmed(error, known); }
        } };
      }
      const parsed = updateScheduled.parse(input), changed = Object.fromEntries(Object.entries(parsed).filter(([key, value]) => ['scheduled_at', 'text', 'name', 'media_keys', 'card_uri'].includes(key) && value !== undefined)), wanted = nativeScheduled.parse({ ...current, ...changed });
      if (equal(config(wanted), config(nativeScheduled.parse(current)))) throw new AdportError('INVALID_INPUT', 'x: no scheduled-post configuration changed');
      if (!wanted.text.trim() && !wanted.media_keys.length) throw new AdportError('INVALID_INPUT', 'x: scheduled post requires text or media');
      this.schedule(wanted.scheduled_at);await this.creatives.verifyAttachments(account, wanted.media_keys, wanted.card_uri);
      if (current.associations.length && parsed.acknowledge_shared_effects !== true) throw new AdportError('INVALID_INPUT', 'x: editing this schedule affects existing ad associations; acknowledge_shared_effects is required');
      const params: XParams = Object.fromEntries(Object.entries(changed).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value === null ? '' : value]));
      return { ...review('Edit scheduled post', [...Object.entries(changed).map(([key, after]) => ({ label: key, before: current[key as keyof ScheduledPost], after })), { label: 'Affected ad associations', after: current.associations.map(row => ({ id: row.id, line_item_id: row.line_item_id })) }]), execute: async () => {
        const known = [current.id];
        try { const row = (await this.entities.client.request('PUT', `${this.base(account)}/scheduled_tweets/${current.id}`, z.object({ data: nativeScheduled }), params)).data;known.push(row.id);if (!equal(config(row), config(wanted)) || !equal(config(await this.raw(account, current.id, input.user_id)), config(wanted))) throw new Error('schedule edit preservation mismatch');return [current.id]; } catch (error) { return this.unconfirmed(error, known); }
      } };
    }
    if (op.tool === 'x_create_scheduled_promoted_post') {
      const { expected_context_hash, acknowledge_automatic_promotion: _ack, ...input } = createScheduledPromotion.parse(op.payload), context = await this.promotionContext(account, input);
      if (context.context_hash !== expected_context_hash || context.existing.length) throw new AdportError('INVALID_INPUT', 'x: scheduled promotion context changed or already associated; read again without replay');
      if (guard.forcePausedCreation && context.parent.line.entity_status !== 'PAUSED') throw new AdportError('POLICY_VIOLATION', 'x: paused_creation requires a currently PAUSED ad group for automatic scheduled promotion');
      const budgetDeltas = [context.parent.line, context.parent.campaign].flatMap(entity => ['daily_budget_amount_local_micro', 'total_budget_amount_local_micro'].flatMap(key => { const amount = entity[key as keyof typeof entity];return typeof amount === 'number' ? [{ target: `${entity.id} ${key} existing pool`, currency: context.parent.campaign.currency, fromMicros: amount, toMicros: amount }] : []; }));
      return { ...review('Associate scheduled post with ad group', [{ label: 'Scheduled post', after: input.scheduled_tweet_id }, { label: 'Copy', after: context.post.text }, { label: 'Publication time', after: context.post.scheduled_at }, { label: 'Ad group', after: input.line_item_id }, { label: 'Ad-group status', after: context.parent.line.entity_status }, { label: 'Campaign status', after: context.parent.campaign.entity_status }, { label: 'Promotion', after: 'Automatic after publication when parents permit delivery' }], context.notes), budgetDeltas, execute: async () => {
        const known: string[] = [];
        try {
          const row = (await this.entities.client.request('POST', `${this.base(account)}/scheduled_promoted_tweets`, z.object({ data: nativeScheduledPromotion }), { line_item_id: input.line_item_id, scheduled_tweet_id: input.scheduled_tweet_id })).data;known.push(row.id);
          if (row.deleted || row.line_item_id !== input.line_item_id || row.scheduled_tweet_id !== input.scheduled_tweet_id || row.tweet_id !== null || row.account_id !== undefined && row.account_id !== account) throw new Error('scheduled-ad receipt mismatch');
          const observed = await this.getPromotion(account, row.id);if (!equal(nativeScheduledPromotion.parse(observed), row) || !equal(observed.parent, context.parent)) throw new Error('scheduled-ad readback mismatch');
          const source = await this.raw(account, input.scheduled_tweet_id, input.user_id);if (!equal(config(source), config(nativeScheduled.parse(context.post)))) throw new Error('scheduled source changed');this.mutable(source);return known;
        } catch (error) { return this.unconfirmed(error, known); }
      } };
    }
    if (op.tool !== 'x_delete_scheduled_promoted_post') throw new AdportError('INVALID_INPUT', 'x: unsupported scheduled operation');
    const input = deleteScheduledPromotion.parse(op.payload), current = await this.getPromotion(account, input.scheduled_promoted_tweet_id);
    if (current.context_hash !== input.expected_context_hash || current.deleted || current.tweet_id !== null) throw new AdportError('INVALID_INPUT', 'x: scheduled association changed, is deleted or already published; inspect current ads');
    const source = await this.raw(account, current.scheduled_tweet_id);await this.author(account, source.user_id);this.mutable(source);
    return { ...review('Remove scheduled post from ad group', [{ label: 'Association', after: current.id }, { label: 'Scheduled post', after: source.id }, { label: 'Ad group', after: current.line_item_id }, { label: 'Deleted', before: false, after: true }], ['Removes this one ad association before publication. The scheduled post still publishes automatically. It is not schedule cancellation or published-post deletion.', notices[1]!]), execute: async () => {
      const known = [current.id];
      try { const row = (await this.entities.client.request('DELETE', `${this.base(account)}/scheduled_promoted_tweets/${current.id}`, z.object({ data: nativeScheduledPromotion }))).data, wanted = { ...nativeScheduledPromotion.parse(current), deleted: true };known.push(row.id);if (!equal(row, wanted) || !equal(nativeScheduledPromotion.parse(await this.getPromotion(account, current.id)), wanted)) throw new Error('scheduled-ad removal mismatch');return [current.id]; } catch (error) { return this.unconfirmed(error, known); }
    } };
  }
}
