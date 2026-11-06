import { createHash } from 'node:crypto';
import { AdportError, type Creative, type ReviewField, type WriteGuard, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { XParams } from './client.js';
import type { XAdsEntities } from './entities.js';
import type { XPostService } from './posts.js';
import { accountMediaList, accountMediaTypes, createDirectMedia, deleteDirectMedia, directMediaList, directMediaSelection, nativeAccountMedia, nativeDirectMedia } from './direct-media-schemas.js';
import { xId } from './schemas.js';

type Asset = z.infer<typeof nativeAccountMedia>;
type Association = z.infer<typeof nativeDirectMedia>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
const pageSchema = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item).max(1000), next_cursor: z.string().nullable().optional() });
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const configuration = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !['created_at', 'updated_at', 'account_id', 'configuration_hash'].includes(key)));
const associationConfiguration = (row: Association) => ({ id: row.id, line_item_id: row.line_item_id, account_media_id: row.account_media_id, creative_type: row.creative_type, landing_url: row.landing_url ?? null, entity_status: row.entity_status, deleted: row.deleted });
const equal = (left: unknown, right: unknown) => hash(left) === hash(right);
const sourceType = (type: string) => type === 'PREROLL' ? 'video' : accountMediaTypes.includes(type as typeof accountMediaTypes[number]) && type !== 'VAST_PREROLL' ? 'image' : undefined;
const url = (value: unknown, media = false) => {
  if (typeof value !== 'string') return undefined;
  try { const parsed = new URL(value);return !parsed.username && !parsed.password && (media ? parsed.protocol === 'https:' && (!parsed.port || parsed.port === '443') && ['pbs.twimg.com', 'video.twimg.com', 'ton.twimg.com'].includes(parsed.hostname) : ['https:', 'http:'].includes(parsed.protocol)) ? value : undefined; } catch { return undefined; }
};
const notice = 'Local preview is not native validation. Account Media assets, ad associations and actual delivery are separate. Native eligibility remains authoritative; no write is retried.';

/** Official X v12 account_media/media_creatives contracts refreshed2026-11-06. */
export class XDirectMediaService {
  constructor(private readonly entities: XAdsEntities, private readonly posts: XPostService) {}
  private base(account: string) { return `accounts/${xId.parse(account)}`; }
  private scope<T extends { id: string; account_id?: string }>(account: string, row: T, id?: string) {
    if (row.account_id !== undefined && row.account_id !== account || id !== undefined && row.id !== id) throw new AdportError('PROVIDER_ERROR', 'x: direct-media account or resource ID mismatch');
    return row;
  }
  private paging(ids: string[], next: string | null | undefined, previous?: string) {
    if (new Set(ids).size !== ids.length || next && next === previous) throw new AdportError('PROVIDER_ERROR', 'x: direct-media pagination repeated an ID or cursor');
    return { truncated: next !== null, ...(next ? { next_cursor: next } : {}), ...(next === undefined || next === '' ? { notes: ['Native continuation marker is missing; completeness is unconfirmed.'] } : {}) };
  }
  private visual(asset: Asset): Creative['media'] {
    const type = sourceType(asset.creative_type), safe = url(asset.media_url, true);
    return !asset.deleted && type && safe ? [{ type, url: safe }] : [];
  }
  private assetCard(account: string, asset: Asset): Creative {
    return { id: asset.id, provider: 'x', account_id: account, name: `Account media ${asset.id}`, type: asset.creative_type, status: asset.deleted ? 'DELETED' : 'PRESENT', headlines: [], descriptions: [], landing_urls: [], media: this.visual(asset), actions: [] };
  }
  async getAsset(account: string, id: string) {
    await this.entities.getAccount(account);
    const row = this.scope(account, (await this.entities.client.request('GET', `${this.base(account)}/account_media/${xId.parse(id)}`, z.object({ data: nativeAccountMedia }), { with_deleted: true })).data, id);
    return { ...row, configuration_hash: hash({ account_id: account, asset: configuration(row) }) };
  }
  async assets(raw: z.input<typeof accountMediaList>) {
    const input = accountMediaList.parse(raw);await this.entities.getAccount(input.account_id);
    const result = await this.entities.client.request('GET', `${this.base(input.account_id)}/account_media`, pageSchema(nativeAccountMedia), { count: input.count, with_deleted: input.with_deleted, ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.creative_types ? { creative_types: input.creative_types.join(',') } : {}) });
    for (const row of result.data) { this.scope(input.account_id, row);if (!input.with_deleted && row.deleted || input.creative_types && !input.creative_types.includes(row.creative_type as typeof accountMediaTypes[number])) throw new AdportError('PROVIDER_ERROR', 'x: Account Media native filter mismatch'); }
    const paging = this.paging(result.data.map(row => row.id), result.next_cursor, input.cursor);
    return { items: result.data, creatives: result.data.map(row => this.assetCard(input.account_id, row)), ...paging, notes: ['Account Media IDs are not media-library keys. Presence does not establish processing readiness, byte identity or ad eligibility.', ...paging.notes ?? []] };
  }
  private async page(account: string, line: string, params: XParams) {
    const result = await this.entities.client.request('GET', `${this.base(account)}/media_creatives`, pageSchema(nativeDirectMedia), { line_item_ids: line, ...params });
    for (const row of result.data) { this.scope(account, row);if (row.line_item_id !== line || params.with_deleted === false && row.deleted) throw new AdportError('PROVIDER_ERROR', 'x: media-creative ad-group/deletion filter mismatch'); }
    this.paging(result.data.map(row => row.id), result.next_cursor, typeof params.cursor === 'string' ? params.cursor : undefined);return result;
  }
  private async existing(account: string, line: string) {
    const rows: Association[] = [], ids = new Set<string>(), cursors = new Set<string>();let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.page(account, line, { count: 200, with_deleted: false, ...(cursor ? { cursor } : {}) });
      for (const row of result.data) { if (ids.has(row.id)) throw new AdportError('PROVIDER_ERROR', 'x: media-creative inventory repeated an ID');ids.add(row.id);rows.push(row); }
      if (result.next_cursor === null) return rows.sort((a, b) => a.id.localeCompare(b.id));
      if (!result.next_cursor || cursors.has(result.next_cursor)) break;
      cursor = result.next_cursor;cursors.add(cursor);
    }
    throw new AdportError('PROVIDER_ERROR', 'x: media-creative inventory is incomplete; no association was submitted');
  }
  private associationHash(account: string, row: Association, parent: unknown) { return hash({ account_id: account, association: associationConfiguration(row), parent }); }
  async get(account: string, id: string) {
    await this.entities.getAccount(account);
    const row = this.scope(account, (await this.entities.client.request('GET', `${this.base(account)}/media_creatives/${xId.parse(id)}`, z.object({ data: nativeDirectMedia }), { with_deleted: true })).data, id);
    const parent = await this.posts.parents(account, row.line_item_id);
    return { ...row, parent: parent.snapshot, context_hash: this.associationHash(account, row, parent.snapshot) };
  }
  async context(account: string, raw: z.input<typeof directMediaSelection>) {
    const input = directMediaSelection.parse(raw), parent = await this.posts.parents(account, input.line_item_id), source = await this.getAsset(account, input.account_media_id);
    if (parent.line.deleted || parent.campaign.deleted || !['ACTIVE', 'PAUSED'].includes(parent.line.entity_status) || !['ACTIVE', 'PAUSED'].includes(parent.campaign.entity_status) || parent.line.product_type !== 'MEDIA') throw new AdportError('INVALID_INPUT', 'x: direct media needs an existing non-draft MEDIA ad group and campaign');
    if (source.deleted || !sourceType(source.creative_type)) throw new AdportError('INVALID_INPUT', 'x: choose an existing PREROLL or documented TAP image asset; VAST/unknown authoring is not verified');
    if (source.creative_type === 'PREROLL' && input.landing_url !== undefined) throw new AdportError('INVALID_INPUT', 'x: landing_url is ignored for preroll; use separate native preroll CTA settings');
    if (parent.line.objective === 'WEBSITE_CLICKS' && !input.landing_url) throw new AdportError('INVALID_INPUT', 'x: WEBSITE_CLICKS requires an explicit landing_url');
    const existing = await this.existing(account, input.line_item_id), context = { account_id: account, request: input, source: configuration(source), parent: parent.snapshot, existing: existing.map(associationConfiguration) };
    return { ...context, context_hash: hash(context), creatives: [this.assetCard(account, source)], truncated: false, notes: ['Native creation adds an ACTIVE association. paused_creation requires a currently PAUSED ad group; parent delivery and budgets are preserved.', 'The source is an existing native Account Media ID. No upload, media-library registration, post publication, CTA edit or source-byte verification is performed.', 'Omitted display destinations may use native defaults. Preroll click destinations belong to separate line-item CTA settings. Format/objective/placement compatibility is checked by X.', 'Snapshots do not atomically lock native concurrent changes. Reconcile unknown outcomes before any new association.', notice] };
  }
  async list(raw: z.input<typeof directMediaList>) {
    const input = directMediaList.parse(raw), parent = await this.posts.parents(input.account_id, input.line_item_id), result = await this.page(input.account_id, input.line_item_id, { count: input.count, with_deleted: input.with_deleted, ...(input.cursor ? { cursor: input.cursor } : {}) });
    const sources = new Map<string, Asset>(), warnings: string[] = [], wanted = [...new Set(result.data.map(row => row.account_media_id))];let index = 0;
    if (input.include_media) await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, async () => { while (index < wanted.length) { const id = wanted[index++]!;try { sources.set(id, await this.getAsset(input.account_id, id)); } catch { warnings.push(`Account Media ${id} could not be read; its association remains visible.`); } } }));
    const creatives: Creative[] = result.data.map(row => {
      const source = sources.get(row.account_media_id), matching = source && !source.deleted && source.creative_type === row.creative_type;
      if (source && !matching) warnings.push(`Account Media ${row.account_media_id} is deleted or has a different format; its preview is unavailable.`);
      const destination = row.creative_type === 'PREROLL' || row.creative_type === 'VAST_PREROLL' ? undefined : url(row.landing_url);
      return { id: row.id, provider: 'x', account_id: input.account_id, campaign_id: parent.campaign.id, ad_group_id: row.line_item_id, name: `Media ad ${row.id}`, type: `${row.creative_type}_ASSOCIATION`, status: row.deleted ? 'DISASSOCIATED' : row.entity_status, headlines: [], descriptions: [], landing_urls: destination ? [destination] : [], media: matching ? this.visual(source) : [], actions: row.deleted ? [] : [{ label: 'Remove from ad group', tool: 'x_delete_media_creative', arguments: { account_id: input.account_id, media_creative_id: row.id, expected_context_hash: this.associationHash(input.account_id, row, parent.snapshot) }, fields: [] }] };
    });
    return { items: result.data.map(row => ({ ...row, context_hash: this.associationHash(input.account_id, row, parent.snapshot) })), parent: parent.snapshot, creatives, warnings, notes: ['Native ACTIVE is association state, not evidence of ad delivery. Removing an association retains its Account Media source.', 'Preroll CTA settings are separate; this gallery does not infer a preroll destination from landing_url.'], ...this.paging(result.data.map(row => row.id), result.next_cursor, input.cursor) };
  }
  private unconfirmed(error: unknown, known: string[]): never {
    const previous = error instanceof AdportError && error.details && typeof error.details === 'object' && 'resource_ids' in error.details && Array.isArray(error.details.resource_ids) ? error.details.resource_ids.filter((value): value is string => typeof value === 'string' && xId.safeParse(value).success) : [];
    throw new AdportError('PROVIDER_ERROR', 'x: direct-media association outcome was not confirmed. Reconcile known IDs and current inventory before another mutation; no write was retried.', { resource_ids: [...new Set([...known, ...previous])] });
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const account = xId.parse(op.accountId), create = op.tool === 'x_create_media_creative';
    if (op.provider !== 'x' || op.kind !== (create ? 'create' : 'remove')) throw new AdportError('INVALID_INPUT', 'x: direct-media operation provider/kind mismatch');
    const review = (title: string, fields: ReviewField[], notes: string[]): Omit<Plan, 'execute'> => ({ summary: title, changes: fields.map(field => `${field.label}: ${JSON.stringify(field.after)}`), coercions: [], budgetDeltas: [], notes, review: { provider: 'x', accountId: account, kind: op.kind, title, fields, notices: notes } });
    if (create) {
      const { expected_context_hash, acknowledge_active_association: _ack, ...input } = createDirectMedia.parse(op.payload), context = await this.context(account, input);
      if (context.context_hash !== expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'x: media source/parent/destination/association context changed; read and preview again');
      if (context.existing.some(row => row.account_media_id === input.account_media_id)) throw new AdportError('INVALID_INPUT', 'x: this Account Media already has a live association in the ad group; do not replay creation');
      if (guard.forcePausedCreation && context.parent.line.entity_status !== 'PAUSED') throw new AdportError('POLICY_VIOLATION', 'x: native associations are ACTIVE; paused_creation requires a currently PAUSED ad group');
      const preview = review('Associate direct media', [{ label: 'Account Media', after: input.account_media_id }, { label: 'Format', after: String(context.source.creative_type) }, { label: 'Ad group', after: input.line_item_id }, { label: 'Campaign', after: context.parent.campaign.id }, { label: 'Native association status', after: 'ACTIVE' }, { label: 'Parent delivery', after: String(context.parent.line.entity_status) }, { label: 'Display destination', after: input.landing_url ?? (context.source.creative_type === 'PREROLL' ? 'Separate preroll CTA settings' : 'Native default') }], context.notes);
      const budgetDeltas = [context.parent.campaign, context.parent.line].flatMap(entity => ['daily_budget_amount_local_micro', 'total_budget_amount_local_micro'].flatMap(key => { const value = entity[key as keyof typeof entity];return typeof value === 'number' ? [{ target: `${entity.id} ${key} existing pool`, currency: context.parent.campaign.currency, fromMicros: value, toMicros: value }] : []; }));
      return { ...preview, budgetDeltas, execute: async () => {
        const known: string[] = [];
        try {
          const row = (await this.entities.client.request('POST', `${this.base(account)}/media_creatives`, z.object({ data: nativeDirectMedia }), input)).data;known.push(row.id);this.scope(account, row);
          if (context.existing.some(prior => prior.id === row.id) || row.deleted || row.entity_status !== 'ACTIVE' || row.line_item_id !== input.line_item_id || row.account_media_id !== input.account_media_id || row.creative_type !== context.source.creative_type || input.landing_url !== undefined && row.landing_url !== input.landing_url) throw new Error('Association receipt differs');
          const observed = await this.get(account, row.id), afterSource = await this.getAsset(account, input.account_media_id);
          if (!equal(associationConfiguration(row), associationConfiguration(observed)) || !equal(observed.parent, context.parent) || !equal(configuration(afterSource), context.source)) throw new Error('Association readback/source differs');
          return [row.id];
        } catch (error) { return this.unconfirmed(error, known); }
      } };
    }
    if (op.tool !== 'x_delete_media_creative') throw new AdportError('INVALID_INPUT', 'x: unsupported direct-media operation');
    const input = deleteDirectMedia.parse(op.payload), current = await this.get(account, input.media_creative_id);
    if (current.deleted || current.context_hash !== input.expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'x: media association/parent changed or was deleted; read and preview again');
    return { ...review('Remove media from ad group', [{ label: 'Association', after: current.id }, { label: 'Account Media retained', after: current.account_media_id }, { label: 'Ad group', after: current.line_item_id }, { label: 'Deleted', before: false, after: true }], ['Removes this one serving association. Its Account Media source, library media, posts, other associations and parent status/budgets are retained.', 'Native entity_status may remain ACTIVE on the deleted tombstone. This is not source deletion or a PUT pause.', notice]), execute: async () => {
      const known = [current.id];
      try {
        const receipt = (await this.entities.client.request('DELETE', `${this.base(account)}/media_creatives/${current.id}`, z.object({ data: nativeDirectMedia }))).data;known.push(receipt.id);this.scope(account, receipt);
        const matches = (row: Association) => row.id === current.id && row.line_item_id === current.line_item_id && row.account_media_id === current.account_media_id && row.creative_type === current.creative_type && (row.landing_url ?? null) === (current.landing_url ?? null) && row.deleted;
        const observed = await this.get(account, current.id);
        if (!matches(receipt) || !matches(observed) || !equal(observed.parent, current.parent)) throw new Error('Disassociation receipt/readback differs');
        return [current.id];
      } catch (error) { return this.unconfirmed(error, known); }
    } };
  }
}
