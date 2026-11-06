import { createHash } from 'node:crypto';
import { AdportError, type Creative, type ReviewField, type WriteGuard, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import type { XParams } from './client.js';
import type { XCreativeService } from './creatives.js';
import { snowflake } from './creative-tools.js';
import type { XAdsEntities } from './entities.js';
import { createPost, createPromotions, createRepostPromotions, deletePromotion, nativePost, postFields, postList, promotionList, promotionSelection, renamePost, type NativePost } from './post-schemas.js';
import { promotedTweetSchema, xId } from './schemas.js';

interface Plan extends Omit<WritePreview, 'serverValidated'> { execute(): Promise<string[] | WriteResult> }
const nativePromotion = promotedTweetSchema.extend({ account_id: xId.optional(), approval_status: z.string().optional() });
type Promotion = z.infer<typeof nativePromotion>;
const pageSchema = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item).max(1000), next_cursor: z.string().nullable().optional() });
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const equal = (a: unknown, b: unknown) => hash(a) === hash(b);
const sourceConfig = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !['created_at', 'updated_at', 'media_url', 'poster_media_url'].includes(key)));
const postContent = (post: NativePost) => ({ ...post });
const postSnapshot = (account: string, post: NativePost) => hash({ account_id: account, post: postContent(post) });
const safeUrl = (value: unknown, cdn = false) => {
  if (typeof value !== 'string') return undefined;
  try { const url = new URL(value);return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && (!cdn || ['pbs.twimg.com', 'video.twimg.com', 'ton.twimg.com'].includes(url.hostname)) ? value : undefined; } catch { return undefined; }
};
const notice = 'Native previews are local plans, not X validation. No write is retried automatically. Published posts, ad associations and actual delivery are separate states.';

/** Official xdevplatform/docs creatives a9226e10 and campaign-management570f918c, checked2026-11-06. */
export class XPostService {
  constructor(private readonly entities: XAdsEntities, private readonly creatives: XCreativeService) {}
  private base(account: string) { return `accounts/${xId.parse(account)}`; }
  private async author(account: string, user: string, full = false) {
    const matches = (await this.creatives.users(account)).filter(row => row.user_id === user && !row.deleted);
    if (matches.length !== 1 || !['FULL', 'RETWEETS_ONLY'].includes(matches[0]!.promotable_user_type) || full && matches[0]!.promotable_user_type !== 'FULL') throw new AdportError('INVALID_INPUT', full ? 'x: this workflow requires a current FULL promotable author; RETWEETS_ONLY creates a different native post and needs its own receipt workflow' : 'x: post author is not an unambiguous current promotable user in this account');
    return matches[0]!;
  }
  private paging(ids: string[], next: string | null | undefined, previous?: string) {
    if (new Set(ids).size !== ids.length || next && next === previous) throw new AdportError('PROVIDER_ERROR', 'x: post pagination repeated an ID or cursor');
    return { truncated: next !== null, ...(next ? { next_cursor: next } : {}), ...(next === undefined ? { notes: ['Native continuation marker is missing; completeness is unconfirmed.'] } : {}) };
  }
  private async postPage(account: string, user: string, params: XParams) {
    const result = await this.entities.client.request('GET', `${this.base(account)}/tweets`, pageSchema(nativePost), { tweet_type: 'PUBLISHED', user_id: user, trim_user: true, ...Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)) });
    if (result.data.some(post => post.user.id_str !== user)) throw new AdportError('PROVIDER_ERROR', 'x: published post author filter mismatch');
    this.paging(result.data.map(post => post.id_str), result.next_cursor, typeof params.cursor === 'string' ? params.cursor : undefined);
    return result;
  }
  private async exactPosts(account: string, user: string, ids: string[]) {
    await this.author(account, user);
    const found = new Map<string, NativePost>(), cursors = new Set<string>();let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.postPage(account, user, { tweet_ids: ids.join(','), timeline_type: 'ALL', include_mentions_and_replies: true, count: 200, ...(cursor ? { cursor } : {}) });
      for (const post of result.data) {
        if (!ids.includes(post.id_str) || found.has(post.id_str)) throw new AdportError('PROVIDER_ERROR', 'x: targeted post lookup returned duplicate or unrequested IDs');
        found.set(post.id_str, post);
      }
      if (result.next_cursor === null) {
        if (ids.some(id => !found.has(id))) throw new AdportError('INVALID_INPUT', 'x: not every requested published post was returned for this account/author; missing data does not prove global absence');
        return ids.map(id => found.get(id)!);
      }
      if (!result.next_cursor || cursors.has(result.next_cursor)) break;
      cursor = result.next_cursor;cursors.add(cursor);
    }
    throw new AdportError('PROVIDER_ERROR', 'x: targeted post lookup is incomplete; no mutation submitted');
  }
  async get(account: string, user: string, id: string) {
    const post = (await this.exactPosts(xId.parse(account), snowflake.parse(user), [snowflake.parse(id)]))[0]!;
    return { ...post, snapshot_hash: postSnapshot(account, post) };
  }
  private visual(post: NativePost): Creative['media'] {
    const media = post.extended_entities?.media ?? post.entities?.media ?? [];
    return media.flatMap<Creative['media'][number]>(item => {
      const poster = safeUrl(item.media_url_https, true);
      if (item.type === 'photo') return poster ? [{ type: 'image' as const, url: poster }] : [];
      const video = item.video_info?.variants.filter(variant => variant.content_type === 'video/mp4' && safeUrl(variant.url, true)).sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
      return video ? [{ type: 'video' as const, url: video.url, ...(poster ? { poster_url: poster } : {}) }] : poster ? [{ type: 'image' as const, url: poster, alt: 'Video poster' }] : [];
    });
  }
  private creative(account: string, post: NativePost, canRename = true): Creative {
    return { id: post.id_str, provider: 'x', account_id: account, name: post.name ?? `Post ${post.id_str}`, type: post.nullcast ? 'PROMOTED_ONLY_POST' : 'ORGANIC_POST', status: 'PUBLISHED', headlines: [], descriptions: [post.full_text], landing_urls: (post.entities?.urls ?? []).flatMap(value => { const url = safeUrl(value.expanded_url);return url ? [url] : []; }), media: this.visual(post), actions: canRename ? [{ label: 'Rename post', tool: 'x_rename_published_post', arguments: { account_id: account, user_id: post.user.id_str, tweet_id: post.id_str, expected_snapshot_hash: postSnapshot(account, post) }, fields: [{ key: 'name', label: 'Post name', type: 'text', value: post.name ?? '', max_length: 80 }] }] : [] };
  }
  async list(raw: z.input<typeof postList>) {
    const input = postList.parse(raw), author = await this.author(input.account_id, input.user_id);
    const { account_id, user_id, ...params } = input;
    const result = await this.postPage(account_id, user_id, params);
    if (result.data.some(post => input.timeline_type !== 'ALL' && post.nullcast !== (input.timeline_type === 'NULLCAST'))) throw new AdportError('PROVIDER_ERROR', 'x: published timeline filter mismatch');
    return { items: result.data.map(post => ({ ...post, snapshot_hash: postSnapshot(account_id, post) })), creatives: result.data.map(post => this.creative(account_id, post, author.promotable_user_type === 'FULL')), ...this.paging(result.data.map(post => post.id_str), result.next_cursor, input.cursor), warnings: ['PUBLISHED describes post publication, not an ad association or delivery. Published copy is not editable through the native name route.'] };
  }
  async creationContext(account: string, raw: z.input<typeof postFields>) {
    const input = postFields.parse(raw), actor = await this.creatives.verifyComposer(account, input.as_user_id), sources = await this.creatives.verifyAttachments(account, input.media_keys ?? [], input.card_uri);
    if (Object.keys(input).some(key => key.startsWith('video_')) && !(sources.media.length === 1 && sources.media[0]!.media_type === 'VIDEO')) throw new AdportError('INVALID_INPUT', 'x: video metadata requires one ready native VIDEO attachment');
    const context = { account_id: account, request: input, actor, sources: { media: sources.media.map(sourceConfig), cards: sources.cards.map(sourceConfig) } };
    return { ...context, context_hash: hash(context), notes: ['Creates a distinct promoted-only published post, not an unpublished draft. Existing drafts are retained. It is not placed on the public timeline or served to followers by the nullcast endpoint, but remains published content usable by ads.', notice] };
  }
  async parents(account: string, lineId: string) {
    await this.entities.getAccount(account);
    const line = await this.entities.getLineItem(account, lineId), campaign = await this.entities.getCampaign(account, line.campaign_id);
    const lineConfig = Object.fromEntries(Object.entries(line).filter(([key]) => !['created_at', 'updated_at', 'approval_status', 'reasons_not_servable', 'servable'].includes(key)));
    return { line, campaign, snapshot: { line: lineConfig, campaign } };
  }
  private scopedPromotion(account: string, row: Promotion, line?: string) {
    if (row.account_id !== undefined && row.account_id !== account || line && row.line_item_id !== line) throw new AdportError('PROVIDER_ERROR', 'x: promoted-post account/line-item mismatch');
    return row;
  }
  private async promotionPage(account: string, line: string, params: XParams) {
    const result = await this.entities.client.request('GET', `${this.base(account)}/promoted_tweets`, pageSchema(nativePromotion), { line_item_ids: line, ...params });
    result.data.forEach(row => this.scopedPromotion(account, row, line));
    this.paging(result.data.map(row => row.id), result.next_cursor, typeof params.cursor === 'string' ? params.cursor : undefined);return result;
  }
  private async existing(account: string, line: string) {
    const rows: Promotion[] = [], cursors = new Set<string>(), ids = new Set<string>();let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.promotionPage(account, line, { count: 200, with_deleted: false, ...(cursor ? { cursor } : {}) });
      for (const row of result.data) { if (row.deleted || ids.has(row.id)) throw new AdportError('PROVIDER_ERROR', 'x: active promotion scan contains deleted/duplicate rows');ids.add(row.id);rows.push(row); }
      if (result.next_cursor === null) return rows;
      if (!result.next_cursor || cursors.has(result.next_cursor)) break;
      cursor = result.next_cursor;cursors.add(cursor);
    }
    throw new AdportError('PROVIDER_ERROR', 'x: promotion scan is incomplete; no mutation submitted');
  }
  private promotionHash(account: string, row: Promotion, parents: unknown) { return hash({ account_id: account, promotion: row, parents }); }
  async getPromotion(account: string, id: string) {
    await this.entities.getAccount(account);
    const row = this.scopedPromotion(account, (await this.entities.client.request('GET', `${this.base(account)}/promoted_tweets/${xId.parse(id)}`, z.object({ data: nativePromotion }), { with_deleted: true })).data);
    if (row.id !== id) throw new AdportError('PROVIDER_ERROR', 'x: promoted-post ID mismatch');
    const parents = await this.parents(account, row.line_item_id);
    return { ...row, context_hash: this.promotionHash(account, row, parents.snapshot), parent: parents.snapshot };
  }
  async promotionContext(account: string, raw: z.input<typeof promotionSelection>) {
    const input = promotionSelection.parse(raw);await this.author(account, input.user_id, true);
    const parents = await this.parents(account, input.line_item_id);
    if (parents.line.deleted || parents.campaign.deleted || !['ACTIVE', 'PAUSED'].includes(parents.line.entity_status) || !['ACTIVE', 'PAUSED'].includes(parents.campaign.entity_status) || !['PROMOTED_TWEETS', 'PROMOTED_ACCOUNT'].includes(parents.line.product_type)) throw new AdportError('INVALID_INPUT', 'x: promotions require an existing supported non-draft campaign/ad group');
    const posts = await this.exactPosts(account, input.user_id, input.tweet_ids);
    if (posts.some(post => post.truncated)) throw new AdportError('INVALID_INPUT', 'x: source copy is truncated; read complete post content before promotion');
    const existing = (await this.existing(account, input.line_item_id)).filter(row => input.tweet_ids.includes(row.tweet_id));
    const context = { account_id: account, request: input, parent: parents.snapshot, posts, existing };
    return { ...context, context_hash: hash(context), notes: ['New native associations are ACTIVE; there is no PUT status. Under paused_creation the ad group itself must be PAUSED. The native API has no atomic compare-and-set, so snapshots do not lock concurrent account changes.', 'RETWEETS_ONLY copy promotion and scheduled associations are separate workflows.', notice] };
  }
  private async repostState(account: string, input: z.infer<typeof promotionSelection>) {
    const users = await this.creatives.users(account), sources = users.filter(row => row.user_id === input.user_id && !row.deleted), receiving = users.filter(row => row.promotable_user_type === 'FULL' && !row.deleted);
    if (sources.length !== 1 || sources[0]!.promotable_user_type !== 'RETWEETS_ONLY' || receiving.length !== 1 || receiving[0]!.user_id === input.user_id) throw new AdportError('INVALID_INPUT', 'x: repost promotion needs one current RETWEETS_ONLY source author and one unambiguous FULL receiving author; use ordinary promotion for FULL sources');
    const parent = await this.parents(account, input.line_item_id);
    if (parent.line.deleted || parent.campaign.deleted || !['ACTIVE', 'PAUSED'].includes(parent.line.entity_status) || !['ACTIVE', 'PAUSED'].includes(parent.campaign.entity_status) || !['PROMOTED_TWEETS', 'PROMOTED_ACCOUNT'].includes(parent.line.product_type)) throw new AdportError('INVALID_INPUT', 'x: repost promotion requires supported existing non-draft parents');
    const posts = await this.exactPosts(account, input.user_id, input.tweet_ids);
    if (posts.some(post => post.truncated)) throw new AdportError('INVALID_INPUT', 'x: repost source copy is truncated; read complete content before promotion');
    const existing = (await this.existing(account, input.line_item_id)).sort((a, b) => a.id.localeCompare(b.id));
    return { account_id: account, request: input, source_author: sourceConfig(sources[0]!), receiving_author: sourceConfig(receiving[0]!), parent: parent.snapshot, posts, existing };
  }
  async repostContext(account: string, raw: z.input<typeof promotionSelection>) {
    const input = promotionSelection.parse(raw), context = await this.repostState(xId.parse(account), input);
    return { ...context, context_hash: hash(context), creatives: context.posts.map(post => this.creative(account, post, false)), truncated: false, notes: ['Each selected original produces a new PUBLISHED nullcast repost plus a native ACTIVE association. This is not an unpublished draft or organic timeline publication.', 'Existing reposts have different post IDs. Source-ID deduplication is not established by the native association inventory; approval explicitly permits new copies, including additional copies of previously promoted sources.', 'The tool correlates one approved source with one native POST receipt. Batches use at most four concurrent requests and can stop partially; no native write is retried. Independently observed copy metadata does not certify source-content or attachment rendering equivalence.', 'paused_creation requires a currently PAUSED ad group. No parent status or budget is changed; snapshots do not lock native concurrent changes.', notice] };
  }
  async promotions(raw: z.input<typeof promotionList>) {
    const input = promotionList.parse(raw), parents = await this.parents(input.account_id, input.line_item_id);
    if (input.user_id) await this.author(input.account_id, input.user_id);
    const result = await this.promotionPage(input.account_id, input.line_item_id, { count: input.count, with_deleted: input.with_deleted, ...(input.cursor ? { cursor: input.cursor } : {}) });
    if (!input.with_deleted && result.data.some(row => row.deleted)) throw new AdportError('PROVIDER_ERROR', 'x: native promotion deletion filter mismatch');
    const posts = new Map<string, NativePost>(), warnings: string[] = ['Native ACTIVE is association state, not proof of delivery. Removing an association retains its published post.'];
    if (input.user_id && result.data.length) {
      const wanted = [...new Set(result.data.map(row => row.tweet_id))].slice(0, 100);
      try { (await this.exactPosts(input.account_id, input.user_id, wanted)).forEach(post => posts.set(post.id_str, post)); }
      catch { warnings.push('Published content was not verified for the selected author; native association references remain visible.'); }
      if (new Set(result.data.map(row => row.tweet_id)).size > 100) warnings.push('Content hydration is limited to100 distinct posts per page.');
    }
    const creatives: Creative[] = result.data.map(row => {
      const post = posts.get(row.tweet_id), visual = post ? this.creative(input.account_id, post) : undefined;
      return { ...(visual ?? { provider: 'x', account_id: input.account_id, headlines: [], descriptions: [], landing_urls: [], media: [] }), id: row.id, name: post?.name ?? `Promoted post ${row.tweet_id}`, type: 'PROMOTED_POST_ASSOCIATION', status: row.deleted ? 'DISASSOCIATED' : row.entity_status, campaign_id: parents.campaign.id, ad_group_id: row.line_item_id, actions: row.deleted ? [] : [{ label: 'Remove from ad group', tool: 'x_delete_promoted_post', arguments: { account_id: input.account_id, promoted_tweet_id: row.id, expected_context_hash: this.promotionHash(input.account_id, row, parents.snapshot) }, fields: [] }] };
    });
    return { items: result.data.map(row => ({ ...row, context_hash: this.promotionHash(input.account_id, row, parents.snapshot) })), parent: parents.snapshot, creatives, warnings, ...this.paging(result.data.map(row => row.id), result.next_cursor, input.cursor) };
  }
  private unconfirmed(error: unknown, known: string[]): never {
    const previous = error instanceof AdportError && error.details && typeof error.details === 'object' && 'resource_ids' in error.details && Array.isArray(error.details.resource_ids) ? error.details.resource_ids.filter((value): value is string => typeof value === 'string') : [];
    throw new AdportError('PROVIDER_ERROR', 'x: post/promotion outcome was not confirmed. Reconcile known IDs and current inventory before another mutation; no write was retried.', { resource_ids: [...new Set([...known, ...previous])] });
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const account = xId.parse(op.accountId), create = ['x_create_promoted_only_post', 'x_create_promoted_posts', 'x_create_repost_promotions'].includes(op.tool), remove = op.tool === 'x_delete_promoted_post';
    if (op.provider !== 'x' || op.kind !== (create ? 'create' : remove ? 'remove' : 'update')) throw new AdportError('INVALID_INPUT', 'x: post operation provider/kind mismatch');
    const review = (title: string, fields: ReviewField[], notices: string[]): Omit<Plan, 'execute'> => ({ summary: title, changes: fields.map(field => `${field.label}: ${JSON.stringify(field.after)}`), coercions: [], budgetDeltas: [], notes: notices, review: { provider: 'x', accountId: account, kind: op.kind, title, fields, notices } });
    if (op.tool === 'x_create_repost_promotions') {
      const { expected_context_hash, acknowledge_active_associations: _active, acknowledge_new_published_copies: _copies, ...input } = createRepostPromotions.parse(op.payload), context = await this.repostContext(account, input);
      if (context.context_hash !== expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'x: repost source/author/parent/association context changed; read and preview again');
      if (guard.forcePausedCreation && context.parent.line.entity_status !== 'PAUSED') throw new AdportError('POLICY_VIOLATION', 'x: native repost associations are ACTIVE; paused_creation requires a currently PAUSED ad group');
      const receivingUser = snowflake.parse(context.receiving_author.user_id), baselineIds = new Set(context.existing.map(row => row.id)), baselineTweets = new Set(context.existing.map(row => row.tweet_id));
      const budgetDeltas = [context.parent.line, context.parent.campaign].flatMap(entity => ['daily_budget_amount_local_micro', 'total_budget_amount_local_micro'].flatMap(key => { const value = entity[key as keyof typeof entity];return typeof value === 'number' ? [{ target: `${entity.id} ${key} existing pool`, currency: context.parent.campaign.currency, fromMicros: value, toMicros: value }] : []; }));
      const fields: ReviewField[] = [{ label: 'Source author', after: input.user_id }, { label: 'Receiving author', after: receivingUser }, { label: 'Ad group', after: input.line_item_id }, { label: 'Ad-group status', after: context.parent.line.entity_status }, { label: 'Campaign status', after: context.parent.campaign.entity_status }, { label: 'New publication', after: `${input.tweet_ids.length} promoted-only repost(s)` }, { label: 'Association state', after: 'ACTIVE' }, ...context.posts.map(post => ({ label: `Source post ${post.id_str}`, after: post.full_text }))];
      return { ...review('Create promoted repost copies', fields, context.notes), budgetDeltas, execute: async () => {
        type Mapping = { source_tweet_id: string; copied_tweet_id: string; promoted_tweet_id: string };
        const mappings = new Map<string, Mapping>(), knownIds = new Set<string>(), knownCopies = new Set<string>(), attempted = new Set<string>(), ambiguous = new Set<string>(), failures: string[] = [];
        const receiptSources = new Map<string, Set<string>>();
        let next = 0, stopped = false;
        const record = (kind: 'association' | 'post', id: string, source: string) => {
          const key = `${kind}:${id}`, sources = receiptSources.get(key) ?? new Set<string>();sources.add(source);receiptSources.set(key, sources);
          if (sources.size > 1) { stopped = true;for (const value of sources) { ambiguous.add(value);mappings.delete(value); } }
        };
        const worker = async () => {
          while (!stopped && next < input.tweet_ids.length) {
            const source = input.tweet_ids[next++]!;
            try {
              const parent = await this.parents(account, input.line_item_id), author = await this.author(account, input.user_id), recipient = await this.author(account, receivingUser, true), observedSource = (await this.exactPosts(account, input.user_id, [source]))[0]!;
              if (!equal(parent.snapshot, context.parent) || !equal(sourceConfig(author), context.source_author) || !equal(sourceConfig(recipient), context.receiving_author) || !equal(observedSource, context.posts.find(row => row.id_str === source))) throw new AdportError('PENDING_MISMATCH', 'x: repost preflight changed before the next native request');
              if (stopped) break;
              attempted.add(source);
              // One original per native request gives an explicit request/receipt mapping.
              const body = await this.entities.client.request('POST', `${this.base(account)}/promoted_tweets`, z.object({ data: z.unknown() }), { line_item_id: input.line_item_id, tweet_ids: source });
              const raw = Array.isArray(body.data) ? body.data : [body.data];
              for (const item of raw) if (item && typeof item === 'object') {
                const row = item as Record<string, unknown>, id = xId.safeParse(row.id), copy = snowflake.safeParse(row.tweet_id);if (id.success) { knownIds.add(id.data);record('association', id.data, source); }if (copy.success) { knownCopies.add(copy.data);record('post', copy.data, source); }
              }
              const rows = z.array(nativePromotion.extend({ tweet_id: snowflake })).length(1).parse(body.data), row = rows[0]!;
              if (ambiguous.has(source) || row.line_item_id !== input.line_item_id || row.deleted || row.entity_status !== 'ACTIVE' || row.account_id !== undefined && row.account_id !== account || input.tweet_ids.includes(row.tweet_id) || baselineIds.has(row.id) || baselineTweets.has(row.tweet_id)) throw new Error('repost receipt scope/state/mapping mismatch');
              const association = await this.getPromotion(account, row.id);
              if (!equal(nativePromotion.parse(association), row) || !equal(association.parent, context.parent)) throw new Error('repost association readback mismatch');
              const copy = (await this.exactPosts(account, receivingUser, [row.tweet_id]))[0]!;
              if (!copy.nullcast || copy.truncated) throw new Error('copied publication metadata mismatch');
              // Check uniqueness again after awaits, before accepting this concurrent result.
              if (ambiguous.has(source)) throw new Error('duplicate repost mapping');
              mappings.set(source, { source_tweet_id: source, copied_tweet_id: row.tweet_id, promoted_tweet_id: row.id });
            } catch (error) {
              stopped = true;failures.push(source);
              if (error instanceof AdportError && error.details && typeof error.details === 'object' && 'resource_ids' in error.details && Array.isArray(error.details.resource_ids)) for (const id of error.details.resource_ids) if (typeof id === 'string' && xId.safeParse(id).success) { knownIds.add(id);record('association', id, source); }
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, input.tweet_ids.length) }, worker));
        const confirmed = input.tweet_ids.flatMap(id => mappings.has(id) ? [mappings.get(id)!] : []);
        if (failures.length || confirmed.length !== input.tweet_ids.length) throw new AdportError('PROVIDER_ERROR', 'x: repost promotion was not fully confirmed. Reconcile the confirmed mappings and reported IDs before another preview; no request was retried and no rollback was attempted.', { resource_ids: [...knownIds], reported_tweet_ids: [...knownCopies], confirmed_source_copy_mappings: confirmed, ambiguous_source_ids: input.tweet_ids.filter(id => ambiguous.has(id)), source_outcomes: input.tweet_ids.filter(id => !mappings.has(id)).map(id => ({ source_tweet_id: id, state: attempted.has(id) ? 'UNCONFIRMED' : 'NOT_STARTED' })), unattempted_source_ids: input.tweet_ids.filter(id => !attempted.has(id)) });
        return { applied: true, resourceIds: confirmed.map(row => row.promoted_tweet_id), details: { source_copy_mappings: confirmed, mapping_basis: 'ONE_SOURCE_PER_NATIVE_REQUEST', copied_post_metadata_verified: true, source_copy_content_equivalence_verified: false, parent_status_or_budget_changed: false, next_tool: 'x_promoted_posts', next_arguments: { account_id: account, line_item_id: input.line_item_id, user_id: receivingUser } }, warnings: ['Mapping follows the documented native copy-promotion request and independently observed association/copy metadata. Source-content and attachment rendering equivalence was not certified; inspect the copied posts before delivery.'] };
      } };
    }
    if (op.tool === 'x_create_promoted_only_post') {
      const { expected_context_hash, confirm_publication: _confirm, ...input } = createPost.parse(op.payload), context = await this.creationContext(account, input);
      if (context.context_hash !== expected_context_hash) throw new AdportError('INVALID_INPUT', 'x: publication source context changed; read and preview it again');
      const params: XParams = { ...Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== 'media_keys' && value !== undefined)), ...(input.media_keys ? { media_keys: input.media_keys.join(',') } : {}), nullcast: true, trim_user: true, tweet_mode: 'extended' };
      return { ...review('Create promoted-only post', [{ label: 'Author', after: input.as_user_id }, { label: 'Text', after: input.text ?? '(media only)' }, { label: 'Name', after: input.name ?? '(unnamed)' }, { label: 'Media', after: input.media_keys ?? [] }, { label: 'Card', after: input.card_uri ?? '(none)' }, { label: 'Replies', after: input.conversation_settings }, ...Object.entries(input).filter(([key]) => key.startsWith('video_')).map(([key, value]) => ({ label: key, after: value })), { label: 'Publication', after: 'PUBLISHED · promoted-only · no ad association' }], context.notes), execute: async () => {
        let known: string | undefined;
        try {
          const receipt = (await this.entities.client.request('POST', `${this.base(account)}/tweet`, z.object({ data: z.object({ id_str: snowflake, user: z.object({ id_str: snowflake }) }) }), params)).data;known = receipt.id_str;
          if (receipt.user.id_str !== input.as_user_id) throw new Error('author mismatch');
          const observed = (await this.exactPosts(account, input.as_user_id, [known]))[0]!;
          if (!observed.nullcast || observed.truncated || observed.conversation_settings !== input.conversation_settings || input.name !== undefined && observed.name !== input.name) throw new Error('publication readback mismatch');
          const textVerified = input.text === undefined || observed.full_text === input.text;
          return { applied: true, resourceIds: [known], details: { publication_confirmed: true, nullcast: true, ad_association_created: false, requested_text_exactly_observed: input.text === undefined ? null : textVerified, attachment_readback_verified: input.media_keys?.length || input.card_uri ? false : null }, warnings: [...(!textVerified ? ['Native published text differs from the submitted text, for example through URL rewriting. Inspect the exact post before promotion; requested text equivalence was not certified.'] : []), ...(input.media_keys?.length || input.card_uri ? ['Source ownership/readiness was checked; published attachment rendering was not independently certified. Inspect the published post before promotion.'] : [])] };
        } catch (error) { return this.unconfirmed(error, known ? [known] : []); }
      } };
    }
    if (op.tool === 'x_rename_published_post') {
      const input = renamePost.parse(op.payload);await this.author(account, input.user_id, true);
      const current = (await this.exactPosts(account, input.user_id, [input.tweet_id]))[0]!;
      if (postSnapshot(account, current) !== input.expected_snapshot_hash) throw new AdportError('INVALID_INPUT', 'x: published post snapshot changed; read and preview it again');
      const expected = { ...current, name: input.name };
      return { ...review('Rename published post', [{ label: 'Post', after: current.id_str }, { label: 'Name', before: current.name, after: input.name }], ['Changes the advertiser label only. Published copy, attachments and ad associations remain separate.', notice]), execute: async () => {
        const known = [current.id_str];
        try {
          const receipt = (await this.entities.client.request('PUT', `${this.base(account)}/tweets/${current.id_str}/name`, z.object({ data: nativePost }), { name: input.name })).data;
          known.push(receipt.id_str);
          if (!equal(postContent(receipt), expected) || !equal(postContent((await this.exactPosts(account, input.user_id, [current.id_str]))[0]!), expected)) throw new Error('name preservation mismatch');
          return [current.id_str];
        } catch (error) { return this.unconfirmed(error, known); }
      } };
    }
    if (op.tool === 'x_create_promoted_posts') {
      const { expected_context_hash, acknowledge_active_associations: _ack, ...input } = createPromotions.parse(op.payload), context = await this.promotionContext(account, input);
      if (context.context_hash !== expected_context_hash) throw new AdportError('INVALID_INPUT', 'x: promotion context changed; read and preview it again');
      if (context.existing.length) throw new AdportError('INVALID_INPUT', 'x: selected post already has a live association in this ad group; do not replay promotion');
      if (guard.forcePausedCreation && context.parent.line.entity_status !== 'PAUSED') throw new AdportError('POLICY_VIOLATION', 'x: native associations are ACTIVE; paused_creation requires a currently PAUSED ad group');
      const fields: ReviewField[] = [{ label: 'Ad group', after: context.parent.line.name ?? input.line_item_id }, { label: 'Campaign', after: context.parent.campaign.name }, { label: 'Ad-group status', after: context.parent.line.entity_status }, { label: 'Campaign status', after: context.parent.campaign.entity_status }, { label: 'Native association status', after: 'ACTIVE' }, ...context.posts.map(post => ({ label: `Post ${post.id_str}`, after: post.full_text }))];
      const base = review('Associate published posts with ad group', fields, [...context.notes, 'An ACTIVE association can serve when its parents permit delivery. No campaign/ad-group status is changed. DELETE disassociates; there is no per-association PUT pause.']);
      const budgetDeltas = [context.parent.line, context.parent.campaign].flatMap(entity => ['daily_budget_amount_local_micro', 'total_budget_amount_local_micro'].flatMap(key => { const value = entity[key as keyof typeof entity];return typeof value === 'number' ? [{ target: `${entity.id} ${key} existing pool`, currency: context.parent.campaign.currency, fromMicros: value, toMicros: value }] : []; }));
      return { ...base, budgetDeltas, execute: async () => {
        let known: string[] = [];
        try {
          const rows = (await this.entities.client.request('POST', `${this.base(account)}/promoted_tweets`, z.object({ data: z.array(nativePromotion).min(1).max(50) }), { line_item_id: input.line_item_id, tweet_ids: input.tweet_ids.join(',') })).data;known = rows.map(row => row.id);
          if (rows.length !== input.tweet_ids.length || new Set(known).size !== rows.length || new Set(rows.map(row => row.tweet_id)).size !== rows.length || rows.some(row => row.deleted || row.entity_status !== 'ACTIVE' || row.line_item_id !== input.line_item_id || !input.tweet_ids.includes(row.tweet_id) || row.account_id !== undefined && row.account_id !== account)) throw new Error('association receipt mismatch');
          for (const row of rows) { const observed = await this.getPromotion(account, row.id);if (!equal({ id: observed.id, line_item_id: observed.line_item_id, tweet_id: observed.tweet_id, entity_status: observed.entity_status, deleted: observed.deleted }, { id: row.id, line_item_id: row.line_item_id, tweet_id: row.tweet_id, entity_status: row.entity_status, deleted: row.deleted }) || !equal(observed.parent, context.parent)) throw new Error('association readback mismatch'); }
          return known;
        } catch (error) { return this.unconfirmed(error, known); }
      } };
    }
    if (op.tool !== 'x_delete_promoted_post') throw new AdportError('INVALID_INPUT', 'x: unsupported post operation');
    const input = deletePromotion.parse(op.payload), current = await this.getPromotion(account, input.promoted_tweet_id);
    if (current.context_hash !== input.expected_context_hash || current.deleted) throw new AdportError('INVALID_INPUT', 'x: promotion context changed or is already deleted; read and preview it again');
    return { ...review('Remove post from ad group', [{ label: 'Association', after: current.id }, { label: 'Published post', after: current.tweet_id }, { label: 'Ad group', after: current.line_item_id }, { label: 'Deleted', before: false, after: true }], ['Disassociates this one ad. The published post, media and other associations remain. Native entity_status may remain ACTIVE on the deleted tombstone; this is not post deletion or a PUT pause.', notice]), execute: async () => {
      const known = [current.id];
      try {
        const receipt = (await this.entities.client.request('DELETE', `${this.base(account)}/promoted_tweets/${current.id}`, z.object({ data: nativePromotion }))).data;known.push(receipt.id);this.scopedPromotion(account, receipt, current.line_item_id);
        const matches = (row: Promotion) => row.id === current.id && row.tweet_id === current.tweet_id && row.line_item_id === current.line_item_id && row.deleted;
        if (!matches(receipt) || !matches(await this.getPromotion(account, current.id))) throw new Error('disassociation readback mismatch');
        return [current.id];
      } catch (error) { return this.unconfirmed(error, known); }
    } };
  }
}
