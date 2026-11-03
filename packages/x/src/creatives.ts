import { AdportError, type Creative, type WriteGuard, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import type { XParams } from './client.js';
import { cardUri, createDraft, draftList, libraryList, mediaKey, snowflake, updateDraft, updateLibrary } from './creative-tools.js';
import type { XAdsEntities } from './entities.js';
import { xId } from './schemas.js';
import type { XWritePlan } from './writes.js';

const draftSchema = z.looseObject({ id: snowflake, user_id: snowflake, text: z.string(), name: z.string().nullable(), nullcast: z.boolean(), card_uri: cardUri.nullable(), media_keys: z.array(mediaKey), status: z.string().optional() });
const librarySchema = z.looseObject({ media_key: mediaKey, media_type: z.enum(['IMAGE', 'VIDEO', 'GIF']), media_status: z.string(), deleted: z.boolean() });
const userSchema = z.looseObject({ id: xId, user_id: snowflake, promotable_user_type: z.string(), deleted: z.boolean() });
const cardSchema = z.looseObject({ id: xId, card_uri: cardUri, deleted: z.boolean(), card_type: z.string() });
const cursor = { next_cursor: z.string().nullable().optional() };
const safeUrl = (value: unknown) => { if (typeof value !== 'string') return undefined; try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && ['pbs.twimg.com', 'video.twimg.com', 'ton.twimg.com'].includes(url.hostname) ? value : undefined; } catch { return undefined; } };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const fieldsMatch = (value: Record<string, unknown>, wanted: Record<string, unknown>) => Object.entries(wanted).every(([key, expected]) => same(value[key], expected));
type Media = z.infer<typeof librarySchema>;
type Draft = z.infer<typeof draftSchema>;

export class XCreativeService {
  constructor(private readonly entities: XAdsEntities) {}
  async users(account: string) {
    await this.entities.getAccount(account);
    return this.entities.client.list(`accounts/${xId.parse(account)}/promotable_users`, userSchema);
  }
  async access(account: string) {
    await this.entities.getAccount(account);
    return (await this.entities.client.request('GET', `accounts/${xId.parse(account)}/authenticated_user_access`, z.object({ data: z.object({ user_id: snowflake, permissions: z.array(z.string()) }) }))).data;
  }
  private async composer(account: string, user: string) {
    if (!(await this.users(account)).some(v => v.user_id === user && v.promotable_user_type === 'FULL' && !v.deleted)) throw new AdportError('INVALID_INPUT', 'x: author must be a current FULL promotable user on the selected account');
    const access = await this.access(account);
    if (access.user_id !== user && !access.permissions.includes('TWEET_COMPOSER')) throw new AdportError('INVALID_INPUT', 'x: authenticated actor needs TWEET_COMPOSER to author for another user');
  }
  async draft(account: string, resource: string) {
    await this.entities.getAccount(account);
    const { data } = await this.entities.client.request('GET', `accounts/${xId.parse(account)}/draft_tweets/${snowflake.parse(resource)}`, z.object({ data: draftSchema }));
    if (data.id !== resource || (data.status !== undefined && data.status !== 'DRAFT')) throw new AdportError('PROVIDER_ERROR', 'x: draft ID/state mismatch');
    return data;
  }
  async media(account: string, resource: string) {
    await this.entities.getAccount(account);
    const { data } = await this.entities.client.request('GET', `accounts/${xId.parse(account)}/media_library/${mediaKey.parse(resource)}`, z.object({ data: librarySchema }));
    if (data.media_key !== resource) throw new AdportError('PROVIDER_ERROR', 'x: media key mismatch');
    return data;
  }
  async cards(account: string, values: string[], withDeleted = false) {
    const wanted = [...new Set(values.map(value => cardUri.parse(value)))];
    if (!wanted.length || wanted.length > 200) throw new AdportError('INVALID_INPUT', 'x: provide 1–200 card URIs');
    await this.entities.getAccount(account);
    const { data } = await this.entities.client.request('GET', `accounts/${xId.parse(account)}/cards/all`, z.object({ data: z.array(cardSchema) }), { card_uris: wanted.join(','), with_deleted: withDeleted });
    if (data.some(v => !wanted.includes(v.card_uri) || (!withDeleted && v.deleted)) || new Set(data.map(v => v.card_uri)).size !== data.length) throw new AdportError('PROVIDER_ERROR', 'x: card association/filter mismatch');
    return { items: data, missing: wanted.filter(value => !data.some(v => v.card_uri === value)) };
  }
  private async attachments(account: string, keys: string[], card?: string | null) {
    const media = await Promise.all(keys.map(key => this.media(account, key)));
    if (media.some(value => value.deleted || value.media_status !== 'TRANSCODE_COMPLETED')) throw new AdportError('INVALID_INPUT', 'x: every media attachment must be ready and present in the selected account library');
    if (media.length > 4 || (media.some(value => value.media_type !== 'IMAGE') && media.length > 1)) throw new AdportError('INVALID_INPUT', 'x: use up to four images, one GIF or one video');
    if (card && (await this.cards(account, [card])).missing.length) throw new AdportError('INVALID_INPUT', 'x: card is not available in the selected account');
  }
  private page(ids: string[], next: string | null | undefined, previous?: string) {
    if (new Set(ids).size !== ids.length || (next && next === previous)) throw new AdportError('PROVIDER_ERROR', 'x: creative pagination repeated an entity or cursor');
    return { truncated: Boolean(next), ...(next ? { next_cursor: next } : {}) };
  }
  private visual(value: Media): Creative['media'] {
    const url = safeUrl(value.media_url), poster = safeUrl(value.poster_media_url);
    return [...(url ? [{ type: value.media_type === 'IMAGE' ? 'image' as const : 'video' as const, url }] : []), ...(poster && poster !== url ? [{ type: 'image' as const, url: poster, alt: 'Video poster' }] : [])];
  }
  async library(value: z.input<typeof libraryList>) {
    const input = libraryList.parse(value); await this.entities.getAccount(input.account_id);
    const params: XParams = { count: input.count, ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.media_type ? { media_type: input.media_type } : {}), ...(input.q ? { q: input.q } : {}) };
    const result = await this.entities.client.request('GET', `accounts/${input.account_id}/media_library`, z.object({ data: z.array(librarySchema), ...cursor }), params);
    if (result.data.some(v => v.deleted || (input.media_type && v.media_type !== input.media_type))) throw new AdportError('PROVIDER_ERROR', 'x: media library filter/state mismatch');
    const creatives: Creative[] = result.data.map(v => ({ id: v.media_key, provider: 'x', account_id: input.account_id, name: String(v.name ?? v.file_name ?? v.media_key), type: `${v.media_type}_ASSET`, status: v.media_status, headlines: typeof v.title === 'string' && v.title ? [v.title] : [], descriptions: typeof v.description === 'string' && v.description ? [v.description] : [], landing_urls: [], media: this.visual(v), actions: [{ label: 'Rename library media', tool: 'x_update_media_library', arguments: { account_id: input.account_id, media_key: v.media_key }, fields: [{ key: 'name', label: 'Name', type: 'text', value: String(v.name ?? ''), max_length: 100 }] }] }));
    return { items: result.data, creatives, ...this.page(result.data.map(v => v.media_key), result.next_cursor, input.cursor) };
  }
  async drafts(value: z.input<typeof draftList>) {
    const input = draftList.parse(value); await this.entities.getAccount(input.account_id);
    const result = await this.entities.client.request('GET', `accounts/${input.account_id}/draft_tweets`, z.object({ data: z.array(draftSchema), ...cursor }), { count: input.count, ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.user_id ? { user_id: input.user_id } : {}) });
    if (result.data.some(v => (v.status !== undefined && v.status !== 'DRAFT') || (input.user_id && v.user_id !== input.user_id))) throw new AdportError('PROVIDER_ERROR', 'x: draft author/state filter mismatch');
    const sources = new Map<string, Media>(), warnings: string[] = [], wanted = [...new Set(result.data.flatMap(v => v.media_keys))].slice(0, 100); let index = 0;
    if (input.include_media) await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, async () => { while (index < wanted.length) { const key = wanted[index++]!; try { const value = await this.media(input.account_id, key); if (!value.deleted) sources.set(key, value); else warnings.push(`Media ${key} was deleted from the library.`); } catch { warnings.push(`Media ${key} could not be read from this account.`); } } }));
    if (input.include_media && new Set(result.data.flatMap(v => v.media_keys)).size > 100) warnings.push('Preview hydration is limited to 100 distinct media items; native references remain in items.');
    const creatives: Creative[] = result.data.map(v => ({ id: v.id, provider: 'x', account_id: input.account_id, name: v.name ?? `Draft ${v.id}`, type: v.nullcast ? 'PROMOTED_ONLY_DRAFT' : 'ORGANIC_DRAFT', status: 'DRAFT', headlines: [], descriptions: [v.text], landing_urls: [], media: input.include_media ? v.media_keys.flatMap(key => sources.has(key) ? this.visual(sources.get(key)!) : []) : [], actions: [{ label: 'Edit draft copy', tool: 'x_update_draft_tweet', arguments: { account_id: input.account_id, draft_tweet_id: v.id }, fields: [{ key: 'text', label: 'Post text', type: 'text', value: v.text }] }, { label: 'Rename draft', tool: 'x_update_draft_tweet', arguments: { account_id: input.account_id, draft_tweet_id: v.id }, fields: [{ key: 'name', label: 'Draft name', type: 'text', value: v.name ?? '', max_length: 80 }] }] }));
    return { items: result.data, creatives, warnings, ...this.page(result.data.map(v => v.id), result.next_cursor, input.cursor) };
  }
  async plan(op: WriteOperation, _guard: WriteGuard): Promise<XWritePlan> {
    const account = xId.parse(op.accountId), create = op.tool === 'x_create_draft_tweet', remove = ['x_delete_draft_tweet', 'x_delete_media_library_item'].includes(op.tool);
    if (op.provider !== 'x' || op.kind !== (create ? 'create' : remove ? 'remove' : 'update')) throw new AdportError('INVALID_INPUT', 'x: creative operation provider/kind mismatch');
    const plan = (summary: string, changes: string[], execute: () => Promise<string[]>): XWritePlan => ({ summary, changes, execute, coercions: [], budgetDeltas: [] });
    if (['x_update_media_library', 'x_delete_media_library_item'].includes(op.tool)) {
      const input = op.tool === 'x_update_media_library' ? updateLibrary.parse(op.payload) : { media_key: mediaKey.parse(op.payload.media_key) }, current = await this.media(account, input.media_key), { media_key: key, ...fields } = input;
      if (current.deleted) throw new AdportError('INVALID_INPUT', 'x: media library record is already deleted');
      if ('title' in fields || 'description' in fields || 'poster_media_key' in fields) {
        if (current.media_type === 'IMAGE') throw new AdportError('INVALID_INPUT', 'x: title/description/poster changes need video or GIF media');
        if ('poster_media_key' in fields) { if (current.media_type !== 'VIDEO') throw new AdportError('INVALID_INPUT', 'x: poster changes require VIDEO media'); const poster = await this.media(account, fields.poster_media_key!); if (poster.deleted || poster.media_type !== 'IMAGE' || poster.media_status !== 'TRANSCODE_COMPLETED') throw new AdportError('INVALID_INPUT', 'x: poster must be a ready account-owned image'); }
      }
      const expected = remove ? { deleted: true } : { ...fields, deleted: false }, preserved = remove ? {} : Object.fromEntries(['name', 'file_name', 'title', 'description', 'poster_media_key'].filter(key => !(key in fields) && key in current).map(key => [key, current[key]]));
      return plan(`${remove ? 'Delete' : 'Edit'} X media library ${key}`, [remove ? 'Delete the library record. Existing posts/ads may retain media. This neither pauses delivery nor proves underlying bytes were deleted.' : `Metadata can be shared by existing creatives. Change only ${JSON.stringify(fields)}; preserve other metadata.`], async () => {
        try {
          const { data } = await this.entities.client.request(remove ? 'DELETE' : 'PUT', `accounts/${account}/media_library/${key}`, z.object({ data: librarySchema.partial().required({ media_key: true }) }), fields);
          if (data.media_key !== key || (data.media_type !== undefined && data.media_type !== current.media_type) || !fieldsMatch(data, Object.fromEntries(Object.entries({ ...preserved, ...expected }).filter(([key]) => key in data))) || (remove && data.deleted !== true)) throw new AdportError('PROVIDER_ERROR', 'x: media-library receipt mismatch; reconcile before retrying', { resource_ids: [data.media_key, key] });
          if (!remove) { const observed = await this.media(account, key); if (observed.media_type !== current.media_type || !fieldsMatch(observed, { ...preserved, ...expected })) throw new Error('x: media-library readback mismatch; reconcile before retrying'); }
          return [key];
        } catch (error) { throw new AdportError('PROVIDER_ERROR', error instanceof Error ? error.message : 'x: media-library update failed; reconcile before retrying', { resource_ids: [key] }); }
      });
    }
    if (!['x_create_draft_tweet', 'x_update_draft_tweet', 'x_delete_draft_tweet'].includes(op.tool)) throw new AdportError('INVALID_INPUT', 'x: unsupported creative operation');
    const current: Draft | undefined = create ? undefined : await this.draft(account, snowflake.parse(op.payload.draft_tweet_id));
    if (remove) return plan(`Permanently delete X draft ${current!.id}`, [`Hard delete draft authored by ${current!.user_id}; this cannot be undone. Already published posts remain separate.`], async () => {
      const { data } = await this.entities.client.request('DELETE', `accounts/${account}/draft_tweets/${current!.id}`, z.object({ data: z.looseObject({ id: snowflake, user_id: snowflake.optional(), status: z.string() }) }));
      if (data.id !== current!.id || (data.user_id !== undefined && data.user_id !== current!.user_id) || data.status !== 'DELETED') throw new AdportError('PROVIDER_ERROR', 'x: draft-deletion receipt mismatch; reconcile before retrying', { resource_ids: [data.id] });
      return [data.id];
    });
    const input = create ? createDraft.parse(op.payload) : updateDraft.parse(op.payload), user = create ? createDraft.parse(input).as_user_id : current!.user_id;
    await this.composer(account, user);
    const expected = { text: input.text ?? current?.text ?? '', name: input.name ?? current?.name ?? null, media_keys: input.media_keys ?? current?.media_keys ?? [], card_uri: input.card_uri !== undefined ? input.card_uri : current?.card_uri ?? null, nullcast: create ? true : current!.nullcast, user_id: user };
    if (!expected.text.trim() && !expected.media_keys.length) throw new AdportError('INVALID_INPUT', 'x: final draft needs text or media');
    await this.attachments(account, input.media_keys ?? [], input.card_uri);
    const fields: XParams = { ...(create ? { as_user_id: user, nullcast: true } : {}), ...(input.text !== undefined ? { text: input.text } : {}), ...(input.name !== undefined ? { name: input.name } : {}), ...(input.media_keys !== undefined ? { media_keys: input.media_keys.join(',') } : {}), ...(input.card_uri !== undefined ? { card_uri: input.card_uri ?? '' } : {}) };
    return plan(`${create ? 'Create' : 'Edit'} X native draft`, [`Author ${user}; native draft only, no publication or ad association. ${JSON.stringify(expected)}`, 'Native weighted text length and content eligibility are checked by X only on apply; this local preview is not server validation.'], async () => {
      let data: Draft;
      try {
        if (create) ({ data } = await this.entities.client.request('POST', `accounts/${account}/draft_tweets`, z.object({ data: draftSchema }), fields));
        else {
          // Live text-only PUT omits name. GET returns its preserved value.
          const receipt = (await this.entities.client.request('PUT', `accounts/${account}/draft_tweets/${current!.id}`, z.object({ data: draftSchema.partial().required({ id: true }) }), fields)).data;
          if (receipt.id !== current!.id || !fieldsMatch(receipt, Object.fromEntries(Object.entries(expected).filter(([key]) => key in receipt)))) throw new AdportError('PROVIDER_ERROR', 'x: partial draft receipt mismatch; reconcile before retrying', { resource_ids: [receipt.id, current!.id] });
          data = await this.draft(account, current!.id);
        }
      }
      catch (error) { if (!create) throw new AdportError('PROVIDER_ERROR', error instanceof Error ? error.message : 'x: draft update failed; reconcile before retrying', { resource_ids: [current!.id] }); throw error; }
      if ((!create && data.id !== current!.id) || (data.status !== undefined && data.status !== 'DRAFT') || !fieldsMatch(data, expected)) throw new AdportError('PROVIDER_ERROR', 'x: draft receipt differs from the approved content; reconcile before retrying', { resource_ids: [data.id] });
      return [data.id];
    });
  }
}
