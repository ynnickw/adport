import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMedia, type WriteOperation } from '@adport/core';
import { MicrosoftAdsClient } from '../src/client.js';
import { MicrosoftAdsProvider } from '../src/provider.js';
import { microsoftTools } from '../src/tools.js';

// REST contracts: MicrosoftDocs/Advertising@fdee2fcf and BingAds Python SDK@4b6fb31c.
// CSV flags, Text additional field and nested association arrays also live-verified.
type Row = Record<string, unknown>;
const account = '777', guard = { forcePausedCreation: true };
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const sha = createHash('sha256').update(bytes).digest('hex');
const image = (Id = '42'): Row => ({ Id, MediaType: 'GenericImage', Text: 'Actual alt text', Representations: [{ Type: 'ImageMediaRepresentation', Url: 'https://www.bing.com/th?id=test-image', Width: 640, Height: 640 }] });
function fixture(override?: (path: string, body: Row, method: string) => unknown, sourceBytes = bytes) {
  const calls: Array<{ path: string; body: Row; init: RequestInit }> = [];
  const state = { images: [image()], uses: [] as Row[] };
  const client = new MicrosoftAdsClient({ developerToken: 'dev', clientId: 'client', refreshToken: 'refresh' }, undefined, async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token', expires_in: 3600 });
    const path = url.pathname.replace(/^.*\/v13\//, ''), body = JSON.parse(String(init.body ?? '{}')) as Row, method = init.method ?? 'POST';
    calls.push({ path, body, init });
    const custom = override?.(path, body, method);
    if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (path === 'User/Query') return Response.json({ User: { Id: '1' } });
    if (path === 'Accounts/Search') return Response.json({ Accounts: [{ Id: account, ParentCustomerId: '9001' }] });
    if (path === 'MediaMetaData/QueryByAccountId') {
      const page = body.PageInfo as { Index: number; Size: number };
      return Response.json({ MediaMetaData: state.images.slice(page.Index * page.Size, (page.Index + 1) * page.Size) });
    }
    if (path === 'MediaAssociations/Query') return Response.json({ PartialErrors: [], MediaAssociations: [state.uses] });
    if (path === 'Media' && method === 'POST') {
      const upload = (body.Media as Row[])[0]!;
      state.images.push({ ...image('43'), Text: upload.Text });
      return Response.json({ MediaIds: ['43'] });
    }
    if (path === 'Media' && method === 'DELETE') {
      state.images = state.images.filter(value => !(body.MediaIds as string[]).includes(String(value.Id)));
      return Response.json({ PartialErrors: [null] });
    }
    throw new Error(`Unexpected path ${path}`);
  });
  const provider = new MicrosoftAdsProvider(client, {}, { read: async (source, options) => verifyMedia(sourceBytes, 'qa.png', source.expected_sha256, options) });
  return { provider, calls, state };
}
const operation = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'create'): WriteOperation => ({ tool, provider: 'microsoft', accountId: account, kind, payload });

describe('Microsoft account image library', () => {
  it('constructs tools lazily and does not invent an existing-image alt-text update', () => {
    const tools = microsoftTools(new Proxy({} as MicrosoftAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    expect(tools.map(tool => tool.name)).toContain('microsoft_upload_image');
    expect(tools.some(tool => /microsoft_(update_image_text|rename_image)$/.test(tool.name))).toBe(false);
  });

  it('reads native CSV flags, explicit alt text and scoped previews with a real continuation', async () => {
    const { provider, calls, state } = fixture();
    state.images.push(image('43'));
    const first = await provider.images.list({ account_id: account, page_index: 0, page_size: 1 });
    expect(first).toMatchObject({ truncated: true, next_page_index: 1, images: [{ Id: '42' }], creatives: [{ id: '42', descriptions: ['Actual alt text'], media: [{ url: 'https://www.bing.com/th?id=test-image', alt: 'Actual alt text' }] }] });
    expect(first.creatives[0]).not.toHaveProperty('status');
    const read = calls.find(call => call.path === 'MediaMetaData/QueryByAccountId')!;
    expect(read.body).toEqual({ MediaEnabledEntities: 'ImageAdExtension, ResponsiveAd', PageInfo: { Index: 0, Size: 1 }, ReturnAdditionalFields: 'Text' });
    expect(read.init.headers).toMatchObject({ CustomerAccountId: account, CustomerId: '9001', DeveloperToken: 'dev', authorization: 'Bearer token' });
    const next = await provider.images.list({ account_id: account, page_index: 1, page_size: 1 });
    expect(next.images[0]!.Id).toBe('43');
    expect(await provider.images.list({ account_id: account, page_index: 2, page_size: 1 })).toMatchObject({ creatives: [], truncated: false });
  });

  it('verifies library membership and keeps unapproved preview origins out of the widget', async () => {
    const { provider, state } = fixture();
    state.images[0]!.Representations = [{ Url: 'https://example.com/pixel' }];
    expect((await provider.images.get({ account_id: account, image_id: '42' })).creatives[0]!.media).toEqual([]);
    await expect(provider.images.get({ account_id: account, image_id: '99' })).rejects.toThrow('not found');
  });

  it('fails closed for unsafe IDs, missing metadata and stalled account-library pages', async () => {
    await expect(fixture(path => path === 'MediaMetaData/QueryByAccountId' ? { MediaMetaData: [{ Id: 9007199254740992 }] } : undefined).provider.images.list({ account_id: account, page_index: 0, page_size: 1 })).rejects.toThrow('unsafe native media ID');
    const missing = fixture(path => path === 'MediaMetaData/QueryByAccountId' ? {} : undefined);
    await expect(missing.provider.images.list({ account_id: account, page_index: 0, page_size: 1 })).rejects.toThrow('metadata was not returned');
    const repeated = fixture(path => path === 'MediaMetaData/QueryByAccountId' ? { MediaMetaData: Array.from({ length: 1000 }, (_, i) => image(String(i + 1))) } : undefined);
    await expect(repeated.provider.images.get({ account_id: account, image_id: '99999' })).rejects.toThrow('did not advance');
  });

  it('checks exact source bytes during preview and uploads only on apply, with a verified native receipt', async () => {
    const { provider, calls } = fixture();
    const op = operation('microsoft_upload_image', { media_id: '11111111-1111-4111-8111-111111111111', expected_sha256: sha, alt_text: 'QA alt text' });
    const preview = await provider.previewWrite(op, guard);
    expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [], coercions: [] });
    expect(preview.changes.join(' ')).toContain(sha);
    expect(calls).toEqual([]);
    expect(await provider.applyWrite(op, guard)).toEqual({ applied: true, resourceIds: ['43'] });
    expect(calls.find(call => call.path === 'Media')!.body).toEqual({ AccountId: account, Media: [{ Type: 'Image', MediaType: 'GenericImage', Text: 'QA alt text', Data: Buffer.from(bytes).toString('base64') }] });
    expect(calls.some(call => /Ads|Extensions/.test(call.path))).toBe(false);
  });

  it('rejects checksum changes and the documented base64 byte cap before provider requests', async () => {
    const f = fixture();
    await expect(f.provider.previewWrite(operation('microsoft_upload_image', { file_path: '/tmp/qa.png', expected_sha256: 'a'.repeat(64) }), guard)).rejects.toThrow('SHA-256 mismatch');
    expect(f.calls).toEqual([]);
    const large = new Uint8Array(76801); large.set(bytes);
    const tooLarge = fixture(undefined, large);
    await expect(tooLarge.provider.previewWrite(operation('microsoft_upload_image', { file_path: '/tmp/qa.png', expected_sha256: createHash('sha256').update(large).digest('hex') }), guard)).rejects.toThrow();
    expect(tooLarge.calls).toEqual([]);
  });

  it('preserves created IDs when upload readback fails and never retries the mutation', async () => {
    const { provider, calls } = fixture(path => path === 'MediaMetaData/QueryByAccountId' ? { MediaMetaData: [] } : undefined);
    await expect(provider.applyWrite(operation('microsoft_upload_image', { file_path: '/tmp/qa.png', expected_sha256: sha }), guard)).rejects.toMatchObject({ details: { resourceIds: ['43'] } });
    expect(calls.filter(call => call.path === 'Media')).toHaveLength(1);
  });

  it('reads nested image-extension associations without claiming responsive-ad coverage', async () => {
    const { provider, calls, state } = fixture();
    state.uses = [{ MediaId: '42', EntityId: '88', MediaEnabledEntity: 'ImageAdExtension' }];
    expect(await provider.images.extensionUses({ account_id: account, image_id: '42' })).toMatchObject({ associations: state.uses, coverage: expect.stringContaining('ResponsiveAd uses are not returned') });
    expect(calls.at(-1)!.body).toEqual({ MediaEnabledEntities: 'ImageAdExtension', MediaIds: ['42'] });
    await expect(provider.previewWrite(operation('microsoft_delete_image', { image_id: '42' }, 'remove'), guard)).rejects.toThrow('assigned to an image extension');
    expect(calls.some(call => call.init.method === 'DELETE')).toBe(false);
  });

  it('rejects missing or foreign association receipts', async () => {
    for (const groups of [[null], [[{ MediaId: '99', EntityId: '88', MediaEnabledEntity: 'ImageAdExtension' }]]]) {
      const f = fixture(path => path === 'MediaAssociations/Query' ? { MediaAssociations: groups } : undefined);
      await expect(f.provider.images.extensionUses({ account_id: account, image_id: '42' })).rejects.toThrow();
    }
  });

  it('deletes an unused image through native DELETE and confirms disappearance', async () => {
    const { provider, calls } = fixture(), op = operation('microsoft_delete_image', { image_id: '42' }, 'remove');
    await provider.previewWrite(op, guard);
    expect(calls.some(call => call.init.method === 'DELETE')).toBe(false);
    expect(await provider.applyWrite(op, guard)).toEqual({ applied: true, resourceIds: ['42'] });
    expect(calls.find(call => call.init.method === 'DELETE')!.body).toEqual({ AccountId: account, MediaIds: ['42'] });
  });

  it('retains the native atomic refusal for responsive-ad assignments and does not retry', async () => {
    const { provider, calls } = fixture((path, _body, method) => path === 'Media' && method === 'DELETE' ? Response.json({ Type: 'ApiFaultDetail', OperationErrors: [{ Code: 4024, ErrorCode: 'CampaignServiceMediaIsAssociated', Message: 'Media is associated' }] }, { status: 400 }) : undefined);
    await expect(provider.applyWrite(operation('microsoft_delete_image', { image_id: '42' }, 'remove'), guard)).rejects.toThrow('4024');
    expect(calls.filter(call => call.init.method === 'DELETE')).toHaveLength(1);
  });
});
