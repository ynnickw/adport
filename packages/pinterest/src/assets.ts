import { createHash } from 'node:crypto';
import { AdportError, LocalMediaResolver, creativesOutput, defineTool, guardedWriteTool, mediaSourceFields, type AnyToolDefinition, type Creative, type MediaResolver, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { PinterestAdsClient } from './client.js';
import type { PinterestAdsProvider } from './provider.js';
import { pinterestId } from './schemas.js';
import { pinMedia } from './creatives.js';

const id = z.string().regex(/^\d+$/).max(30), hash = z.string().regex(/^[a-f0-9]{64}$/);
const privacy = z.enum(['PUBLIC', 'PROTECTED', 'SECRET']);
const username = z.string().min(1), owner = z.object({ username });
const boardSchema = z.looseObject({ id, name: z.string(), privacy, owner, is_ads_only: z.boolean().optional() });
const pinSchema = z.looseObject({ id, board_id: id, title: z.string().nullable().optional(), description: z.string().nullable().optional(), alt_text: z.string().nullable().optional(), link: z.string().nullable().optional(), is_owner: z.boolean().optional(), has_been_promoted: z.boolean().optional() });
const mediaSchema = z.object({ media_id: id, media_type: z.literal('video'), status: z.enum(['registered', 'processing', 'succeeded', 'failed']) });
const source = z.object(mediaSourceFields).refine(v => Boolean(v.media_id) !== Boolean(v.file_path), 'Choose project media_id or local file_path');
const link = z.string().max(2048).url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }, 'Use an HTTP(S) destination without credentials');
const copy = { title: z.string().max(100).nullable().optional(), description: z.string().max(800).nullable().optional(), alt_text: z.string().max(500).nullable().optional(), link: link.nullable().optional() };
const pinCreation = { board_id: id, expected_board_privacy: privacy, original_content: z.literal(true), confirm_publication: z.boolean().default(false), ...copy };
const createImage = source.safeExtend(pinCreation);
const createVideo = z.object({ ...pinCreation, native_media_id: id, cover_image_key_frame_time: z.number().int().nonnegative().safe().default(0) });
const createBoard = z.object({ name: z.string().trim().min(1).max(180), description: z.string().max(500).optional(), privacy: privacy.default('SECRET'), confirm_publication: z.boolean().default(false) });
const updatePin = z.object({ pin_id: id, expected_snapshot_hash: hash, ...copy }).strict().refine(v => Object.keys(copy).some(key => v[key as keyof typeof v] !== undefined), 'Provide Pin copy to update');
const deletePin = z.object({ pin_id: id, expected_snapshot_hash: hash }).strict();
const kinds = { pinterest_create_board: 'create', pinterest_create_image_pin: 'create', pinterest_upload_video: 'create', pinterest_create_video_pin: 'create', pinterest_update_pin: 'update', pinterest_delete_pin: 'remove' } as const;
export const PINTEREST_ASSET_WRITES = new Set(Object.keys(kinds));
type Plan = Omit<WritePreview, 'serverValidated'> & { execute: () => Promise<string[]> };
type Page = { account_id: string; page_size: number; bookmark?: string };
type Pin = z.infer<typeof pinSchema>;
function snapshot(pin: Pin, board: z.infer<typeof boardSchema>) {
  return createHash('sha256').update(JSON.stringify({ id: pin.id, board_id: pin.board_id, title: pin.title ?? null, description: pin.description ?? null, alt_text: pin.alt_text ?? null, link: pin.link ?? null, is_owner: pin.is_owner, has_been_promoted: pin.has_been_promoted, privacy: board.privacy, owner: board.owner.username, is_ads_only: board.is_ads_only ?? false })).digest('hex');
}
function copyFields(input: Record<string, unknown>) { return Object.fromEntries(Object.keys(copy).filter(key => input[key] !== undefined).map(key => [key, input[key]])); }
function plan(summary: string, changes: string[], execute: Plan['execute']): Plan { return { summary, changes, coercions: [], budgetDeltas: [], notes: ['Preview is local. Pinterest permissions and app access are checked by the native API; there is no server dry-run.'], execute }; }

/** Contracts from Pinterest-owned v5 OpenAPI 5.28.0, fetched 2026-11-04. */
export class PinterestAssetService {
  constructor(private readonly client: PinterestAdsClient, private readonly media: MediaResolver = new LocalMediaResolver()) {}
  private params(account: string) { return new URLSearchParams({ ad_account_id: pinterestId.parse(account) }); }
  private async account(account: string) {
    const current = await this.client.get(`ad_accounts/${pinterestId.parse(account)}`, z.object({ id: pinterestId, owner }));
    if (current.id !== account) throw new AdportError('PROVIDER_ERROR', 'pinterest: advertiser response ID mismatch');
    return current;
  }
  private async ownedBoard(account: string, boardId: string) {
    const current = await this.account(account);
    const board = await this.client.get(`boards/${id.parse(boardId)}`, boardSchema, this.params(account));
    if (board.id !== boardId || board.owner.username.toLowerCase() !== current.owner.username.toLowerCase()) throw new AdportError('INVALID_INPUT', 'pinterest: board is not owned by the selected advertiser; collaborator boards are not writable through this workflow');
    return board;
  }
  private async nativeOwner(account: string) {
    const current = await this.account(account);
    // /media has no ad_account_id parameter: bind this credential-global resource
    // to the selected advertiser, rather than silently using the token user's library.
    const tokenOwner = await this.client.get('user_account', z.object({ username }));
    if (current.owner.username.toLowerCase() !== tokenOwner.username.toLowerCase()) throw new AdportError('INVALID_INPUT', 'pinterest: native video uploads belong to the token user; the selected advertiser must have that same owner');
  }
  private async page<T>(path: string, schema: z.ZodType<T>, input: Page, params: URLSearchParams) {
    params.set('page_size', String(input.page_size));
    if (input.bookmark) params.set('bookmark', input.bookmark);
    const data = await this.client.get(path, z.object({ items: z.array(schema), bookmark: z.string().nullable().optional() }), params);
    if (data.items.length > input.page_size || data.bookmark && (data.bookmark === input.bookmark || !data.items.length)) throw new AdportError('PROVIDER_ERROR', 'pinterest: media pagination did not advance');
    return { ...data, truncated: Boolean(data.bookmark), ...(data.bookmark ? { next_cursor: data.bookmark } : {}) };
  }
  async boards(input: Page & { privacy?: 'ALL' | 'PUBLIC' | 'PROTECTED' | 'SECRET' | 'PUBLIC_AND_SECRET' }) {
    const current = await this.account(input.account_id), params = this.params(input.account_id);
    if (input.privacy) params.set('privacy', input.privacy);
    const result = await this.page('boards', boardSchema, input, params);
    return { ...result, items: result.items.map(board => ({ ...board, owned_by_advertiser: board.owner.username.toLowerCase() === current.owner.username.toLowerCase() })) };
  }
  async getPin(account: string, pinId: string) {
    const pin = await this.client.get(`pins/${id.parse(pinId)}`, pinSchema, this.params(account));
    if (pin.id !== pinId) throw new AdportError('PROVIDER_ERROR', 'pinterest: Pin response ID mismatch');
    const board = await this.ownedBoard(account, pin.board_id);
    const snapshotHash = snapshot(pin, board);
    const creative: Creative = { id: pin.id, provider: 'pinterest', account_id: account, name: pin.title || pin.id, type: 'ORIGINAL_PIN', status: board.privacy, headlines: pin.title ? [pin.title] : [], descriptions: pin.description ? [pin.description] : [], landing_urls: pin.link && link.safeParse(pin.link).success ? [pin.link] : [], media: pinMedia(pin.media), actions: pin.is_owner === true && pin.has_been_promoted === false ? [{ label: 'Edit original Pin copy', tool: 'pinterest_update_pin', arguments: { account_id: account, pin_id: pin.id, expected_snapshot_hash: snapshotHash }, fields: [{ key: 'title', label: 'Title', type: 'text', value: pin.title ?? '', max_length: 100 }, { key: 'description', label: 'Description', type: 'text', value: pin.description ?? '', max_length: 800 }, { key: 'alt_text', label: 'Alternative text', type: 'text', value: pin.alt_text ?? '', max_length: 500 }, ...(pin.link ? [{ key: 'link', label: 'Destination URL', type: 'text' as const, value: pin.link, max_length: 2048 }] : [])] }] : [] };
    return { pin, board, snapshot_hash: snapshotHash, creatives: [creative], truncated: false };
  }
  async pins(input: Page & { board_id?: string }) {
    if (input.board_id) await this.ownedBoard(input.account_id, input.board_id); else await this.account(input.account_id);
    const data = await this.page(input.board_id ? `boards/${input.board_id}/pins` : 'pins', pinSchema, input, this.params(input.account_id));
    if (input.board_id && data.items.some(pin => pin.board_id !== input.board_id)) throw new AdportError('PROVIDER_ERROR', 'pinterest: Pin collection returned another board');
    const creatives: Creative[] = data.items.map(pin => ({ id: pin.id, provider: 'pinterest', account_id: input.account_id, name: pin.title || pin.id, type: 'ORIGINAL_PIN', headlines: pin.title ? [pin.title] : [], descriptions: pin.description ? [pin.description] : [], landing_urls: pin.link && link.safeParse(pin.link).success ? [pin.link] : [], media: pinMedia(pin.media), actions: [] }));
    return { ...data, creatives, notes: ['Original Pins are shared content. Read pinterest_get_pin for an exact snapshot before editing or deleting; promoted Pins require a new replacement Pin.'] };
  }
  async getMedia(account: string, mediaId: string) {
    await this.nativeOwner(account);
    const current = await this.client.get(`media/${id.parse(mediaId)}`, mediaSchema);
    if (current.media_id !== mediaId) throw new AdportError('PROVIDER_ERROR', 'pinterest: media response ID mismatch');
    return current;
  }
  private checkPublication(board: { privacy: string }, expected: string, confirmed: boolean) {
    if (board.privacy !== expected) throw new AdportError('PENDING_MISMATCH', 'pinterest: board privacy changed; read boards and prepare a new preview');
    if (board.privacy === 'PUBLIC' && !confirmed) throw new AdportError('INVALID_INPUT', 'pinterest: a public board publishes organic content; explicit confirm_publication is required');
  }
  private checkPinReceipt(pin: Pin, boardId: string, fields: Record<string, unknown>, pinId?: string) {
    if (pinId && pin.id !== pinId || pin.board_id !== boardId || Object.entries(fields).some(([key, value]) => (pin[key] ?? null) !== value)) throw new AdportError('PROVIDER_ERROR', 'pinterest: Pin write receipt differs from approved content; reconcile before retrying', { resource_ids: [pin.id] });
    return [pin.id];
  }
  async plan(op: WriteOperation): Promise<Plan> {
    if (op.provider !== 'pinterest' || !PINTEREST_ASSET_WRITES.has(op.tool) || op.kind !== kinds[op.tool as keyof typeof kinds]) throw new AdportError('INVALID_INPUT', 'pinterest: invalid asset operation kind');
    const account = pinterestId.parse(op.accountId), params = this.params(account);
    if (op.tool === 'pinterest_create_board') {
      const input = createBoard.parse(op.payload), current = await this.account(account);
      this.checkPublication(input, input.privacy, input.confirm_publication);
      const { confirm_publication: _confirmed, ...body } = input;
      const native = { ...body, ...(input.privacy === 'PROTECTED' ? { is_ads_only: true } : {}) };
      return plan(`Create Pinterest ${input.privacy} board`, [JSON.stringify(native), input.privacy === 'PROTECTED' ? 'Pinterest names ad-only boards “Ad-only Pins”; they are protected, not secret.' : `Board owned by ${current.owner.username}; no Pin or ad is created.`], async () => {
        const created = await this.client.mutate('boards', 'POST', native, boardSchema, params);
        if (created.owner.username.toLowerCase() !== current.owner.username.toLowerCase() || created.privacy !== input.privacy || input.privacy !== 'PROTECTED' && created.name !== input.name || input.privacy === 'PROTECTED' && created.is_ads_only !== true) throw new AdportError('PROVIDER_ERROR', 'pinterest: created board owner/privacy/name mismatch; reconcile before retrying', { resource_ids: [created.id] });
        return [created.id];
      });
    }
    if (op.tool === 'pinterest_upload_video') {
      const input = source.parse(op.payload); await this.nativeOwner(account);
      const file = await this.media.read(input, { maxBytes: 50 * 1024 * 1024, contentTypes: ['video/mp4'] });
      return plan('Upload Pinterest video source', [`+ ${file.name}; ${file.bytes.length} bytes; SHA-256 ${file.sha256}.`, 'Native token-owner library; no Pin, post, ad or delivery change. Check pinterest_get_media_upload for processing; registered/upload-accepted does not mean succeeded.'], async () => {
        let mediaId: string | undefined;
        try {
          const result = await this.client.mutate('media', 'POST', { media_type: 'video' }, z.object({ media_id: id, media_type: z.literal('video'), upload_url: z.string().url().optional(), upload_parameters: z.record(z.string(), z.string()).optional() }));
          mediaId = result.media_id;
          if (!result.upload_url || !result.upload_parameters) throw new Error('incomplete native upload instructions');
          await this.client.uploadVideo(result.upload_url, result.upload_parameters, file.bytes, file.name);
        } catch (error) {
          const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
          const ids = mediaId ? [mediaId] : Array.isArray(details.resource_ids) ? details.resource_ids.filter((value): value is string => typeof value === 'string' && /^\d{1,30}$/.test(value)).slice(0, 2) : [];
          throw new AdportError('PROVIDER_ERROR', 'pinterest: native video registration/transfer was not confirmed; reconcile before retrying. No mutation was retried.', { resource_ids: ids });
        }
        return [mediaId!];
      });
    }
    if (op.tool === 'pinterest_create_image_pin' || op.tool === 'pinterest_create_video_pin') {
      const image = op.tool === 'pinterest_create_image_pin' ? createImage.parse(op.payload) : undefined, video = image ? undefined : createVideo.parse(op.payload), input = image ?? video!;
      const board = await this.ownedBoard(account, input.board_id);
      this.checkPublication(board, input.expected_board_privacy, input.confirm_publication);
      let mediaSource: Record<string, unknown>, mediaNote: string;
      if (image) {
        const file = await this.media.read(image, { maxBytes: 20 * 1024 * 1024, contentTypes: ['image/png', 'image/jpeg'] });
        mediaSource = { source_type: 'image_base64', content_type: file.contentType, data: Buffer.from(file.bytes).toString('base64') };
        mediaNote = `${file.name}; ${file.bytes.length} bytes; SHA-256 ${file.sha256}.`;
      } else {
        const native = await this.getMedia(account, video!.native_media_id);
        if (native.status !== 'succeeded') throw new AdportError('INVALID_INPUT', `pinterest: video processing is ${native.status}; only succeeded media can create a Pin`);
        mediaSource = { source_type: 'video_id', media_id: native.media_id, cover_image_key_frame_time: video!.cover_image_key_frame_time };
        mediaNote = `Native video ${native.media_id}; cover keyframe ${video!.cover_image_key_frame_time}s.`;
      }
      const fields = copyFields(input), body = { board_id: board.id, ...fields, media_source: mediaSource };
      return plan(`Create Pinterest ${image ? 'image' : 'video'} Pin on ${board.privacy} board`, [mediaNote, `Board ${board.id} “${board.name}”; visibility ${board.privacy}.`, JSON.stringify(fields), 'Creates original content on Pinterest. PUBLIC boards publish organically; PROTECTED is ad-only, not secret. No ad is attached or enabled. Source media is immutable; replace it by creating another Pin.'], async () => this.checkPinReceipt(await this.client.mutate('pins', 'POST', body, pinSchema, params), board.id, fields));
    }
    const input = op.tool === 'pinterest_update_pin' ? updatePin.parse(op.payload) : deletePin.parse(op.payload), current = await this.getPin(account, input.pin_id);
    if (current.snapshot_hash !== input.expected_snapshot_hash) throw new AdportError('PENDING_MISMATCH', 'pinterest: Pin copy, ownership, promotion or board privacy changed; read the Pin again');
    if (current.pin.is_owner !== true || current.pin.has_been_promoted !== false) throw new AdportError('INVALID_INPUT', 'pinterest: only an explicitly owned, never-promoted original Pin can be edited/deleted here. Create a replacement for promoted or unknown usage.');
    if (op.tool === 'pinterest_delete_pin') return plan(`Permanently delete Pinterest Pin ${input.pin_id}`, [`Remove the original ${current.board.privacy} Pin and its content. This cannot be undone; source project media is preserved.`], async () => {
      const receipt = await this.client.mutate(`pins/${input.pin_id}`, 'DELETE', undefined, pinSchema.optional(), params);
      if (receipt && receipt.id !== input.pin_id) throw new AdportError('PROVIDER_ERROR', 'pinterest: deletion receipt ID mismatch; reconcile before retrying', { resource_ids: [input.pin_id] });
      return [input.pin_id];
    });
    const fields = copyFields(input);
    return plan(`Edit original Pinterest Pin ${input.pin_id}`, [`Board ${current.board.id}; visibility ${current.board.privacy}. Source media, board membership and ad delivery are preserved.`, ...Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(current.pin[key] ?? null)} → ${JSON.stringify(value)}`), 'Changes the shared original Pin, including its existing organic display. Native update is beta and may be denied for this app.'], async () => this.checkPinReceipt(await this.client.mutate(`pins/${input.pin_id}`, 'PATCH', fields, pinSchema, params), current.board.id, fields, input.pin_id));
  }
}

export function pinterestAssetTools(provider: PinterestAdsProvider): AnyToolDefinition[] {
  const account = { account_id: pinterestId }, paging = { page_size: z.number().int().min(1).max(250).default(25), bookmark: z.string().min(1).optional() };
  return [
    defineTool({ name: 'pinterest_boards', namespace: 'pinterest', description: 'List selected advertiser-owner boards, privacy and ownership with native pagination. Requires existing boards:read; collaborator boards are labeled, not treated as owned.', input: z.object({ ...account, ...paging, privacy: z.enum(['ALL', 'PUBLIC', 'PROTECTED', 'SECRET', 'PUBLIC_AND_SECRET']).optional() }), annotations: { readOnly: true }, handler: input => provider.assets.boards(input) }),
    defineTool({ name: 'pinterest_pins', namespace: 'pinterest', description: 'View original Pinterest Pin copy/media for this advertiser owner or one owned board. Native bookmark pagination; existing boards:read and pins:read required. No dashboard.', input: z.object({ ...account, ...paging, board_id: id.optional() }), output: creativesOutput.passthrough(), presentation: 'creatives', pagination: { cursorInput: 'bookmark' }, annotations: { readOnly: true }, handler: input => provider.assets.pins(input) }),
    defineTool({ name: 'pinterest_get_pin', namespace: 'pinterest', description: 'View exact original Pin, owned board visibility and snapshot hash. Owned never-promoted Pins expose guarded copy-edit actions. This is separate from advertiser ad settings.', input: z.object({ ...account, pin_id: id }), output: creativesOutput.passthrough(), presentation: 'creatives', annotations: { readOnly: true }, handler: input => provider.assets.getPin(input.account_id, input.pin_id) }),
    defineTool({ name: 'pinterest_get_media_upload', namespace: 'pinterest', description: 'Read native video upload processing. The credential-global media library must match the selected advertiser owner; requires pins:read and user_accounts:read. Never assumes an upload is ready.', input: z.object({ ...account, native_media_id: id }), annotations: { readOnly: true }, handler: input => provider.assets.getMedia(input.account_id, input.native_media_id) }),
    guardedWriteTool({ name: 'pinterest_create_board', namespace: 'pinterest', provider: 'pinterest', kind: 'create', destructive: false, payload: createBoard, description: 'Create an advertiser-owned board, SECRET by default. PUBLIC requires confirm_publication; PROTECTED creates an ad-only board with Pinterest-assigned name. Requires existing boards read/write scopes.' }),
    guardedWriteTool({ name: 'pinterest_create_image_pin', namespace: 'pinterest', provider: 'pinterest', kind: 'create', destructive: false, payload: createImage, description: 'Upload exact SHA-bound PNG/JPEG bytes and create original Pin content on an owned board. Hosted media_id or local file_path; no dashboard. Explicit original_content and current board privacy required. PUBLIC needs confirm_publication. No ad or delivery change.' }),
    guardedWriteTool({ name: 'pinterest_upload_video', namespace: 'pinterest', provider: 'pinterest', kind: 'create', destructive: false, payload: source, description: 'Register and upload SHA-bound MP4 to Pinterest, without creating a Pin or ad. Native media is token-owner scoped, so advertiser owner must match; requires pins read/write and user_accounts:read. Read returned ID processing before create_video_pin. Unknown outcomes are not retried.' }),
    guardedWriteTool({ name: 'pinterest_create_video_pin', namespace: 'pinterest', provider: 'pinterest', kind: 'create', destructive: false, payload: createVideo, description: 'Create original Pin content from succeeded native video and an owned board; cover image uses explicit keyframe seconds. Requires existing boards/pins scopes. Binds current visibility; PUBLIC requires confirm_publication. No advertiser ad is created.' }),
    guardedWriteTool({ name: 'pinterest_update_pin', namespace: 'pinterest', provider: 'pinterest', kind: 'update', payload: updatePin, description: 'Edit supplied title, description, alt text or link of an owned, never-promoted original Pin. Omitted copy, media and board are preserved; null clears a supplied field. Snapshot binds current copy/privacy/promotion. Changes existing organic content; native beta access required.' }),
    guardedWriteTool({ name: 'pinterest_delete_pin', namespace: 'pinterest', provider: 'pinterest', kind: 'remove', payload: deletePin, description: 'Permanently delete an owned, explicitly never-promoted original Pin after matching its current snapshot. Rejects promoted or unknown usage; does not delete project source media.' }),
  ];
}
