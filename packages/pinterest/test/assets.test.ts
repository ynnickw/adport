import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, verifyMedia, type WriteOperation } from '@adport/core';
import { PinterestAdsClient, PINTEREST_TOKEN_URL } from '../src/client.js';
import { PinterestAdsProvider } from '../src/provider.js';
import { pinterestTools } from '../src/tools.js';

// Pinterest-owned OpenAPI5.28.0 /boards, /pins and /media, fetched2026-11-04.
const A = '549000000001', B = '549000000005', P = '1234567890123456789', V = '1234567890123456790';
const owner = { username: 'adport_qa' }, board = { id: B, name: 'QA', privacy: 'SECRET', owner, is_ads_only: false };
const emptyBoard = { ...board, description: 'Original board copy', pin_count: 0, collaborator_count: 0, follower_count: 0 };
const pin = { id: P, board_id: B, title: 'Original', description: 'Preserve me', alt_text: null, link: 'https://example.com', is_owner: true, has_been_promoted: false, media: { media_type: 'image', images: { original: { url: 'https://i.pinimg.com/originals/qa.png', width: 640, height: 640 } } } };
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'), videoBytes = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom0000')]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const guard = { forcePausedCreation: true };
const parameters = { 'Content-Type': 'multipart/form-data', key: `uploads/11/aa/22/3:video:${V}:5212123920968240771`, policy: 'signed-policy', 'x-amz-algorithm': 'AWS4-HMAC-SHA256', 'x-amz-credential': 'signed-credential', 'x-amz-date': '20261104T120000Z', 'x-amz-security-token': 'signed-storage-token', 'x-amz-signature': 'signed-signature' };
const uploadUrl = 'https://pinterest-media-upload.s3-accelerate.amazonaws.com/';
type Call = { url: URL; init: RequestInit };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function fixture(handler?: (call: Call) => unknown | Response, bytes = imageBytes) {
  const calls: Call[] = [], read = vi.fn(async (input: { expected_sha256: string }) => verifyMedia(bytes, bytes === imageBytes ? 'qa.png' : 'qa.mp4', input.expected_sha256));
  const client = new PinterestAdsClient({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' }, async (url, init = {}) => {
    const call = { url: new URL(String(url)), init }; calls.push(call);
    if (String(url) === PINTEREST_TOKEN_URL) return Response.json({ access_token: 'access', expires_in: 3600 });
    const custom = handler?.(call); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (init.method === 'GET') {
      if (call.url.pathname === `/v5/ad_accounts/${A}`) return Response.json({ id: A, owner });
      if (call.url.pathname === `/v5/boards/${B}`) return Response.json(board);
      if (call.url.pathname === `/v5/pins/${P}`) return Response.json(pin);
      if (call.url.pathname === '/v5/user_account') return Response.json(owner);
      if (call.url.pathname === `/v5/media/${V}`) return Response.json({ media_id: V, media_type: 'video', status: 'succeeded' });
    }
    throw new Error(`Unexpected ${init.method} ${call.url.pathname}`);
  });
  return { provider: new PinterestAdsProvider(client, { read }), client, read, calls };
}
const body = (call: Call) => JSON.parse(String(call.init.body));
const writes = (calls: Call[]) => calls.filter(call => call.init.method !== 'GET' && call.url.href !== PINTEREST_TOKEN_URL);
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'create'): WriteOperation => ({ provider: 'pinterest', accountId: A, tool, kind, payload });
const imageInput = { board_id: B, expected_board_privacy: 'SECRET', original_content: true, media_id: 'c4f7a45f-bbee-4dbc-ae06-2988fafad83a', expected_sha256: sha(imageBytes), title: 'New Pin' };

describe('Pinterest original assets without dashboard access', () => {
  it('adds one shared catalog and labels additive asset writes separately from destructive edits', () => {
    const tools = pinterestTools(new Proxy({} as PinterestAdsProvider, { get() { throw new Error('eager provider access'); } }));
    for (const name of ['pinterest_create_board', 'pinterest_create_image_pin', 'pinterest_upload_video', 'pinterest_create_video_pin']) expect(tools.find(t => t.name === name)?.annotations).toMatchObject({ readOnly: false, destructive: false });
    expect(tools.find(t => t.name === 'pinterest_delete_pin')?.annotations).toMatchObject({ readOnly: false, destructive: true });
    expect(tools.find(t => t.name === 'pinterest_pins')?.pagination).toEqual({ cursorInput: 'bookmark' });
  });
  it('passes exact Business Access advertiser query and labels collaborator boards', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === '/v5/boards' ? { items: [board, { ...board, id: '99', owner: { username: 'collaborator' } }], bookmark: 'next/page' } : undefined);
    const result = await provider.assets.boards({ account_id: A, privacy: 'SECRET', page_size: 25, bookmark: 'previous' });
    expect(result.items.map(v => v.owned_by_advertiser)).toEqual([true, false]); expect(result.next_cursor).toBe('next/page');
    expect(Object.fromEntries(calls.at(-1)!.url.searchParams)).toEqual({ ad_account_id: A, privacy: 'SECRET', page_size: '25', bookmark: 'previous' });
    expect(writes(calls)).toEqual([]);
  });
  it('reads an exact owned board and binds copy-edit widget arguments to its snapshot', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === `/v5/boards/${B}` ? emptyBoard : undefined);
    const result = await provider.assets.getBoard(A, B);
    expect(result.board).toMatchObject(emptyBoard); expect(result.snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.creatives[0]).toMatchObject({ type: 'PINTEREST_BOARD', status: 'SECRET', descriptions: ['Original board copy'], actions: [{ tool: 'pinterest_update_board', arguments: { account_id: A, board_id: B, expected_snapshot_hash: result.snapshot_hash }, fields: [{ key: 'name', value: 'QA' }, { key: 'description', value: 'Original board copy' }] }] });
    expect(calls.at(-1)!.url.searchParams.get('ad_account_id')).toBe(A); expect(writes(calls)).toEqual([]);
    const tools = pinterestTools(provider);
    expect(tools.find(t => t.name === 'pinterest_get_board')).toMatchObject({ presentation: 'creatives', annotations: { readOnly: true } });
    for (const name of ['pinterest_update_board', 'pinterest_delete_empty_board']) expect(tools.find(t => t.name === name)?.annotations).toMatchObject({ readOnly: false, destructive: true });
  });
  it('PATCHes only supplied board copy, preserves visibility, and accepts explicit description clearing', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === `/v5/boards/${B}` ? { ...emptyBoard, ...(call.init.method === 'PATCH' ? body(call) : {}) } : undefined);
    const current = await provider.assets.getBoard(A, B);
    const operation = op('pinterest_update_board', { board_id: B, expected_snapshot_hash: current.snapshot_hash, name: board.name, description: null }, 'update');
    const preview = await provider.previewWrite(operation, guard); expect(preview.serverValidated).toBe(false); expect(writes(calls)).toEqual([]);
    expect(preview.fieldChanges).toEqual([{ field: 'Description', before: 'Original board copy', after: '(cleared)' }]);
    expect((await provider.applyWrite(operation, guard)).resourceIds).toEqual([B]);
    expect(writes(calls)).toHaveLength(1); expect(writes(calls)[0]!.url.pathname).toBe(`/v5/boards/${B}`); expect(writes(calls)[0]!.url.searchParams.get('ad_account_id')).toBe(A);
    expect(writes(calls)[0]!.init.method).toBe('PATCH'); expect(body(writes(calls)[0]!)).toEqual({ name: 'QA', description: null });
  });
  it.each([{ name: 'Changed' }, { description: 'Changed' }, { privacy: 'PUBLIC' }, { owner: { username: 'other' } }, { is_ads_only: true }])('rejects changed board copy/visibility/ownership before any write %#', async override => {
    let changed = false;
    const { provider, calls } = fixture(call => call.url.pathname === `/v5/boards/${B}` ? { ...emptyBoard, ...(changed ? override : {}) } : undefined);
    const current = await provider.assets.getBoard(A, B); changed = true;
    await expect(provider.previewWrite(op('pinterest_update_board', { board_id: B, expected_snapshot_hash: current.snapshot_hash, description: 'New' }, 'update'), guard)).rejects.toThrow();
    expect(writes(calls)).toEqual([]);
  });
  it('does not invalidate copy snapshots when independent native counts change', async () => {
    let count = 0;
    const { provider } = fixture(call => call.url.pathname === `/v5/boards/${B}` ? { ...emptyBoard, pin_count: count++ } : undefined);
    expect((await provider.assets.getBoard(A, B)).snapshot_hash).toBe((await provider.assets.getBoard(A, B)).snapshot_hash);
  });
  it('hides native ad-only names from editing and rejects explicit renaming or privacy expansion', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === `/v5/boards/${B}` ? { ...emptyBoard, privacy: 'PROTECTED', is_ads_only: true } : undefined);
    const current = await provider.assets.getBoard(A, B);
    expect(current.creatives[0]!.actions[0]!.fields.map(field => field.key)).toEqual(['description']);
    await expect(provider.previewWrite(op('pinterest_update_board', { board_id: B, expected_snapshot_hash: current.snapshot_hash, name: 'Rename' }, 'update'), guard)).rejects.toThrow('assigned by Pinterest');
    const tool = pinterestTools(provider).find(t => t.name === 'pinterest_update_board')!;
    expect(tool.input.safeParse({ account_id: A, board_id: B, expected_snapshot_hash: current.snapshot_hash, privacy: 'PUBLIC', name: 'Rename' }).success).toBe(false);
    expect(tool.input.safeParse({ account_id: A, board_id: B, expected_snapshot_hash: current.snapshot_hash }).success).toBe(false);
    expect(writes(calls)).toEqual([]);
  });
  it.each([{ privacy: 'PUBLIC' }, { owner: { username: 'other' } }, { name: 'Different' }, { description: 'Unexpected' }, { is_ads_only: true }])('retains the board ID on mismatched update receipts without retry %#', async override => {
    const { provider, calls } = fixture(call => call.url.pathname === `/v5/boards/${B}` ? { ...emptyBoard, ...(call.init.method === 'PATCH' ? { ...body(call), ...override } : {}) } : undefined);
    const current = await provider.assets.getBoard(A, B);
    await expect(provider.applyWrite(op('pinterest_update_board', { board_id: B, expected_snapshot_hash: current.snapshot_hash, description: 'New' }, 'update'), guard)).rejects.toMatchObject({ details: { resource_ids: [B] } });
    expect(writes(calls)).toHaveLength(1);
  });
  it.each([{ privacy: 'PUBLIC' }, { privacy: 'PROTECTED' }, { is_ads_only: true }, { is_ads_only: undefined }, { pin_count: 1 }, { pin_count: undefined }, { collaborator_count: 1 }, { follower_count: 1 }, { collaborator_count: undefined }, { follower_count: undefined }])('rejects nonempty/nonsecret/unknown board deletion %#', async override => {
    const { provider, calls } = fixture(call => call.url.pathname === `/v5/boards/${B}` ? { ...emptyBoard, ...override } : undefined);
    const current = await provider.assets.getBoard(A, B);
    await expect(provider.previewWrite(op('pinterest_delete_empty_board', { board_id: B, expected_snapshot_hash: current.snapshot_hash, confirm_permanent_deletion: true }, 'remove'), guard)).rejects.toThrow('known zero');
    expect(writes(calls)).toEqual([]);
  });
  it.each(['pins', 'sections'])('rejects a board with native %s despite stale zero counts', async collection => {
    const { provider, calls } = fixture(call => call.url.pathname === `/v5/boards/${B}` ? emptyBoard : call.url.pathname === `/v5/boards/${B}/${collection}` ? { items: [collection === 'pins' ? pin : { id: '123', name: 'Section' }] } : call.url.pathname.startsWith(`/v5/boards/${B}/`) ? { items: [] } : undefined);
    const current = await provider.assets.getBoard(A, B);
    await expect(provider.previewWrite(op('pinterest_delete_empty_board', { board_id: B, expected_snapshot_hash: current.snapshot_hash, confirm_permanent_deletion: true }, 'remove'), guard)).rejects.toThrow('contains Pins or sections');
    expect(writes(calls)).toEqual([]);
  });
  it('rechecks native emptiness immediately before DELETE and sends no cascade/body parameters', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === `/v5/boards/${B}` ? call.init.method === 'DELETE' ? new Response(null, { status: 204 }) : emptyBoard : call.url.pathname.startsWith(`/v5/boards/${B}/`) ? { items: [], bookmark: null } : undefined);
    const current = await provider.assets.getBoard(A, B), operation = op('pinterest_delete_empty_board', { board_id: B, expected_snapshot_hash: current.snapshot_hash, confirm_permanent_deletion: true }, 'remove');
    await provider.previewWrite(operation, guard); expect(writes(calls)).toEqual([]);
    expect((await provider.applyWrite(operation, guard)).resourceIds).toEqual([B]);
    const request = writes(calls)[0]!; expect(writes(calls)).toHaveLength(1); expect(request.init.method).toBe('DELETE'); expect(request.init.body).toBeUndefined(); expect(Object.fromEntries(request.url.searchParams)).toEqual({ ad_account_id: A });
    for (const collection of ['pins', 'sections']) {
      const reads = calls.filter(c => c.url.pathname === `/v5/boards/${B}/${collection}`);
      expect(reads).toHaveLength(3); expect(Object.fromEntries(reads[0]!.url.searchParams)).toEqual({ ad_account_id: A, page_size: '1' });
    }
  });
  it('stops when native content appears between apply planning and the final deletion recheck', async () => {
    let reads = 0;
    const { provider, calls } = fixture(call => call.url.pathname === `/v5/boards/${B}` ? emptyBoard : call.url.pathname === `/v5/boards/${B}/pins` ? { items: ++reads > 1 ? [pin] : [] } : call.url.pathname === `/v5/boards/${B}/sections` ? { items: [] } : undefined);
    const current = await provider.assets.getBoard(A, B);
    await expect(provider.applyWrite(op('pinterest_delete_empty_board', { board_id: B, expected_snapshot_hash: current.snapshot_hash, confirm_permanent_deletion: true }, 'remove'), guard)).rejects.toThrow('contains Pins'); expect(writes(calls)).toEqual([]);
  });
  it('rechecks the board snapshot through the shared policy gate before apply and preserves protected-account enforcement', async () => {
    let changed = false;
    const { provider, calls } = fixture(call => call.url.pathname === `/v5/boards/${B}` ? { ...emptyBoard, ...(changed ? { name: 'Changed elsewhere' } : {}) } : undefined);
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-pinterest-board-')); dirs.push(dir);
    const engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))), runtime = await createContext({ providerModules: [{ provider, tools: pinterestTools(provider) }], engine });
    const current = await provider.assets.getBoard(A, B), input = { account_id: A, board_id: B, expected_snapshot_hash: current.snapshot_hash, description: 'New' };
    const preview = await runtime.registry.call('pinterest_update_board', input, runtime.ctx) as { pending_operation_id: string }; changed = true;
    await expect(runtime.registry.call('pinterest_update_board', { ...input, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow('changed'); expect(writes(calls)).toEqual([]);
    const protectedEngine = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(dir, 'protected-pending')), new AuditLog(path.join(dir, 'protected-audit')));
    const protectedRuntime = await createContext({ providerModules: [{ provider, tools: pinterestTools(provider) }], engine: protectedEngine });
    await expect(protectedRuntime.registry.call('pinterest_delete_empty_board', { account_id: A, board_id: B, expected_snapshot_hash: current.snapshot_hash, confirm_permanent_deletion: true }, protectedRuntime.ctx)).rejects.toThrow('protected'); expect(writes(calls)).toEqual([]);
  });
  it('renders native original Pin media and rejects a foreign-board collection', async () => {
    const { provider } = fixture(call => call.url.pathname === `/v5/boards/${B}/pins` ? { items: [pin] } : undefined);
    const result = await provider.assets.pins({ account_id: A, board_id: B, page_size: 25 });
    expect(result.creatives[0]).toMatchObject({ id: P, headlines: ['Original'], media: [{ type: 'image', url: 'https://i.pinimg.com/originals/qa.png' }], actions: [] });
    const foreign = fixture(call => call.url.pathname === `/v5/boards/${B}/pins` ? { items: [{ ...pin, board_id: '99' }] } : undefined);
    await expect(foreign.provider.assets.pins({ account_id: A, board_id: B, page_size: 25 })).rejects.toThrow('another board');
  });
  it.each([{ items: [], bookmark: 'next' }, { items: [pin], bookmark: 'same' }, { items: [pin, pin] }])('rejects non-advancing/oversized native pages %#', async data => {
    const { provider } = fixture(call => call.url.pathname === '/v5/pins' ? data : undefined);
    await expect(provider.assets.pins({ account_id: A, page_size: 1, bookmark: 'same' })).rejects.toThrow('pagination');
  });
  it('defaults new boards to SECRET and sends a JSON object, not an advertising batch', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { ...board, ...body(call) } : undefined);
    const operation = op('pinterest_create_board', { name: 'QA' });
    const preview = await provider.previewWrite(operation, guard); expect(preview.serverValidated).toBe(false); expect(writes(calls)).toEqual([]);
    await provider.applyWrite(operation, guard);
    const request = writes(calls)[0]!; expect(request.url.pathname).toBe('/v5/boards'); expect(request.url.searchParams.get('ad_account_id')).toBe(A); expect(body(request)).toEqual({ name: 'QA', privacy: 'SECRET' });
  });
  it('requires explicit public creation and describes protected ad-only boards honestly', async () => {
    const { provider, calls } = fixture();
    await expect(provider.previewWrite(op('pinterest_create_board', { name: 'Public', privacy: 'PUBLIC' }), guard)).rejects.toThrow('confirm_publication');
    const protectedPreview = await provider.previewWrite(op('pinterest_create_board', { name: 'Ad-only', privacy: 'PROTECTED' }), guard);
    expect(protectedPreview.changes.join(' ')).toContain('not secret'); expect(writes(calls)).toEqual([]);
  });
  it('uploads exact image bytes through server-resolved media and omits internal approval/rights fields', async () => {
    const { provider, calls, read } = fixture(call => call.init.method === 'POST' && call.url.pathname === '/v5/pins' ? { ...pin, title: 'New Pin' } : undefined);
    const operation = op('pinterest_create_image_pin', imageInput);
    const preview = await provider.previewWrite(operation, guard); expect(preview.changes.join(' ')).toContain(sha(imageBytes)); expect(writes(calls)).toEqual([]);
    await provider.applyWrite(operation, guard); expect(read).toHaveBeenCalledTimes(2);
    const request = writes(calls)[0]!; expect(request.url.searchParams.get('ad_account_id')).toBe(A);
    expect(body(request)).toEqual({ board_id: B, title: 'New Pin', media_source: { source_type: 'image_base64', content_type: 'image/png', data: imageBytes.toString('base64') } });
  });
  it('rejects changed bytes, collaborator ownership, stale privacy and unconfirmed public creation before any write', async () => {
    const changed = fixture(); await expect(changed.provider.previewWrite(op('pinterest_create_image_pin', { ...imageInput, expected_sha256: '0'.repeat(64) }), guard)).rejects.toThrow('SHA-256');
    for (const override of [{ owner: { username: 'other' } }, { privacy: 'PUBLIC' }]) {
      const { provider, calls } = fixture(call => call.url.pathname === `/v5/boards/${B}` ? { ...board, ...override } : undefined);
      await expect(provider.previewWrite(op('pinterest_create_image_pin', imageInput), guard)).rejects.toThrow(); expect(writes(calls)).toEqual([]);
    }
    const publicBoard = fixture(call => call.url.pathname === `/v5/boards/${B}` ? { ...board, privacy: 'PUBLIC' } : undefined);
    await expect(publicBoard.provider.previewWrite(op('pinterest_create_image_pin', { ...imageInput, expected_board_privacy: 'PUBLIC' }), guard)).rejects.toThrow('confirm_publication');
  });
  it('does not silently accept a mismatched Pin create receipt', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === '/v5/pins' ? { ...pin, title: 'Wrong' } : undefined);
    await expect(provider.applyWrite(op('pinterest_create_image_pin', imageInput), guard)).rejects.toMatchObject({ details: { resource_ids: [P] } }); expect(writes(calls)).toHaveLength(1);
  });
  it('keeps video upload OAuth on Pinterest API and signed multipart data on exact Storage origin', async () => {
    const { provider, calls } = fixture(call => {
      if (call.url.pathname === '/v5/media') return { media_id: V, media_type: 'video', upload_url: uploadUrl, upload_parameters: parameters };
      if (call.url.href === uploadUrl) return new Response(null, { status: 204 });
    }, videoBytes);
    const operation = op('pinterest_upload_video', { media_id: imageInput.media_id, expected_sha256: sha(videoBytes) });
    await provider.previewWrite(operation, guard); expect(writes(calls)).toEqual([]);
    expect((await provider.applyWrite(operation, guard)).resourceIds).toEqual([V]);
    const [registration, transfer] = writes(calls); expect(registration!.url.search).toBe(''); expect(body(registration!)).toEqual({ media_type: 'video' });
    expect(transfer!.init.headers).toBeUndefined(); expect(transfer!.init.redirect).toBe('error');
    const form = transfer!.init.body as FormData; expect(form.get('policy')).toBe(parameters.policy); expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(videoBytes);
    expect(form.get('file')).toMatchObject({ name: 'qa.mp4', type: 'video/mp4' });
  });
  it('rejects credential-global media for a delegated advertiser owner', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === '/v5/user_account' ? { username: 'other' } : undefined, videoBytes);
    await expect(provider.previewWrite(op('pinterest_upload_video', { media_id: imageInput.media_id, expected_sha256: sha(videoBytes) }), guard)).rejects.toThrow('same owner');
    expect(writes(calls)).toEqual([]);
  });
  it.each(['https://example.com/', 'https://pinterest-media-upload.s3-accelerate.amazonaws.com.evil.test/', `${uploadUrl}?signed=other`, 'http://pinterest-media-upload.s3-accelerate.amazonaws.com/', 'https://user:pass@pinterest-media-upload.s3-accelerate.amazonaws.com/'])('rejects untrusted upload destination %s without sending bytes', async destination => {
    const { client, calls } = fixture(); await expect(client.uploadVideo(destination, parameters, videoBytes, 'qa.mp4')).rejects.toThrow(); expect(calls).toEqual([]);
  });
  it('rejects extra upload fields and retains a registered ID on an uncertain transfer without exposing capabilities', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === '/v5/media' ? { media_id: V, media_type: 'video', upload_url: uploadUrl, upload_parameters: { ...parameters, redirect: 'https://evil.test/' } } : undefined, videoBytes);
    let error: unknown; try { await provider.applyWrite(op('pinterest_upload_video', { media_id: imageInput.media_id, expected_sha256: sha(videoBytes) }), guard); } catch (value) { error = value; }
    expect(error).toMatchObject({ details: { resource_ids: [V] } }); expect(JSON.stringify(error)).not.toContain(parameters.policy); expect(writes(calls)).toHaveLength(1);
  });
  it.each(['registered', 'processing', 'failed'])('does not create a Pin from %s video', async status => {
    const { provider, calls } = fixture(call => call.url.pathname === `/v5/media/${V}` ? { media_id: V, media_type: 'video', status } : undefined);
    await expect(provider.previewWrite(op('pinterest_create_video_pin', { board_id: B, expected_board_privacy: 'SECRET', original_content: true, native_media_id: V }), guard)).rejects.toThrow('only succeeded'); expect(writes(calls)).toEqual([]);
  });
  it('uses succeeded native video with explicit cover keyframe and Business Access query', async () => {
    const { provider, calls } = fixture(call => call.url.pathname === '/v5/pins' ? pin : undefined);
    await provider.applyWrite(op('pinterest_create_video_pin', { board_id: B, expected_board_privacy: 'SECRET', original_content: true, native_media_id: V, cover_image_key_frame_time: 2 }), guard);
    expect(body(writes(calls)[0]!)).toEqual({ board_id: B, media_source: { source_type: 'video_id', media_id: V, cover_image_key_frame_time: 2 } });
  });
  it('edits only supplied original copy and explicitly clears null fields', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'PATCH' ? { ...pin, ...body(call) } : undefined);
    const current = await provider.assets.getPin(A, P);
    expect(current.creatives[0]?.actions[0]).toMatchObject({ tool: 'pinterest_update_pin', arguments: { account_id: A, pin_id: P, expected_snapshot_hash: current.snapshot_hash } });
    await provider.applyWrite(op('pinterest_update_pin', { pin_id: P, expected_snapshot_hash: current.snapshot_hash, title: 'Renamed', alt_text: null }, 'update'), guard);
    expect(body(writes(calls)[0]!)).toEqual({ title: 'Renamed', alt_text: null }); expect(writes(calls)[0]!.url.searchParams.get('ad_account_id')).toBe(A);
  });
  it.each([{ is_owner: false }, { is_owner: undefined }, { has_been_promoted: true }, { has_been_promoted: undefined }])('rejects unowned/promoted/unknown usage %#', async override => {
    const { provider, calls } = fixture(call => call.url.pathname === `/v5/pins/${P}` ? { ...pin, ...override } : undefined);
    const current = await provider.assets.getPin(A, P);
    await expect(provider.previewWrite(op('pinterest_delete_pin', { pin_id: P, expected_snapshot_hash: current.snapshot_hash }, 'remove'), guard)).rejects.toThrow('never-promoted'); expect(writes(calls)).toEqual([]);
  });
  it('rejects a changed snapshot and performs an explicit native DELETE with empty 204 response', async () => {
    let changed = false;
    const { provider, calls } = fixture(call => call.init.method === 'DELETE' ? new Response(null, { status: 204 }) : call.url.pathname === `/v5/pins/${P}` && changed ? { ...pin, title: 'Changed' } : undefined);
    const current = await provider.assets.getPin(A, P); changed = true;
    await expect(provider.previewWrite(op('pinterest_delete_pin', { pin_id: P, expected_snapshot_hash: current.snapshot_hash }, 'remove'), guard)).rejects.toThrow('changed'); expect(writes(calls)).toEqual([]);
    const fresh = await provider.assets.getPin(A, P); await provider.applyWrite(op('pinterest_delete_pin', { pin_id: P, expected_snapshot_hash: fresh.snapshot_hash }, 'remove'), guard);
    expect(writes(calls)).toHaveLength(1); expect(writes(calls)[0]!.init.body).toBeUndefined(); expect(writes(calls)[0]!.url.searchParams.get('ad_account_id')).toBe(A);
  });
  it('does not refresh/retry a native Pin mutation rejected with 401', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? new Response(null, { status: 401 }) : undefined);
    await expect(provider.applyWrite(op('pinterest_create_image_pin', imageInput), guard)).rejects.toThrow('HTTP 401'); expect(writes(calls)).toHaveLength(1); expect(calls.filter(c => c.url.href === PINTEREST_TOKEN_URL)).toHaveLength(1);
  });
  it('retains native IDs from incomplete registration and Pin receipts without exposing response values', async () => {
    const registration = fixture(call => call.url.pathname === '/v5/media' ? { media_id: V, media_type: 'video' } : undefined, videoBytes);
    await expect(registration.provider.applyWrite(op('pinterest_upload_video', { media_id: imageInput.media_id, expected_sha256: sha(videoBytes) }), guard)).rejects.toMatchObject({ details: { resource_ids: [V] } });
    const incompletePin = fixture(call => call.url.pathname === '/v5/pins' ? { id: P, private_field: 'never include' } : undefined);
    await expect(incompletePin.provider.applyWrite(op('pinterest_create_image_pin', imageInput), guard)).rejects.toMatchObject({ details: { resource_ids: [P] } });
    expect(writes(registration.calls)).toHaveLength(1); expect(writes(incompletePin.calls)).toHaveLength(1);
  });
  it('keeps actual tool calls behind protected-account policy and one-use preview/apply', async () => {
    const { provider, calls } = fixture(call => call.init.method === 'POST' ? { ...board, ...body(call) } : undefined);
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-pinterest-assets-')); dirs.push(dir);
    const engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))), runtime = await createContext({ providerModules: [{ provider, tools: pinterestTools(provider) }], engine });
    const input = { account_id: A, name: 'QA' };
    const preview = await runtime.registry.call('pinterest_create_board', input, runtime.ctx) as { pending_operation_id: string }; expect(writes(calls)).toEqual([]);
    const apply = { ...input, pending_operation_id: preview.pending_operation_id }; await runtime.registry.call('pinterest_create_board', apply, runtime.ctx);
    await expect(runtime.registry.call('pinterest_create_board', apply, runtime.ctx)).rejects.toThrow(); expect(writes(calls)).toHaveLength(1);
    const protectedEngine = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(path.join(dir, 'protected-pending')), new AuditLog(path.join(dir, 'protected-audit')));
    const protectedRuntime = await createContext({ providerModules: [{ provider, tools: pinterestTools(provider) }], engine: protectedEngine });
    await expect(protectedRuntime.registry.call('pinterest_create_board', input, protectedRuntime.ctx)).rejects.toThrow('protected'); expect(writes(calls)).toHaveLength(1);
  });
});
