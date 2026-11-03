import { createHash } from 'node:crypto';
import { createContext, verifyMedia, type MediaResolver, type WriteOperation } from '@adport/core';
import { describe, expect, it } from 'vitest';
import { GoogleAdsRestClient } from '../src/client.js';
import { GoogleAdsProvider } from '../src/provider.js';
import { googleTools } from '../src/tools.js';

// Google-owned v25 AssetOperation / Asset / asset_types protos checked2026-11-03.
// AssetOperation has create/update only: deleting an asset is not a native API.
const account = '1234567890', assetId = '42', resource = `customers/${account}/assets/${assetId}`;
const guard = { forcePausedCreation: true };
const asset = { id: assetId, resourceName: resource, type: 'SITELINK', name: 'Shared name', finalUrls: ['https://example.com'], sitelinkAsset: { linkText: 'Old link', description1: 'Keep one', description2: 'Keep two' } };
type Call = { url: string; init: RequestInit; body: Record<string, unknown> };
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]), sha = createHash('sha256').update(bytes).digest('hex');
const media: MediaResolver = { read: async (source, options) => verifyMedia(bytes, 'qa.png', source.expected_sha256, options) };
function fixture(rows: unknown[] = [{ asset }], resolver?: MediaResolver, response: unknown = { results: [{ resourceName: resource }] }) {
  const calls: Call[] = [];
  const client = new GoogleAdsRestClient({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' }, 'v25', async (input, init = {}) => {
    const url = String(input), body = init.body && !url.includes('oauth2.googleapis.com') ? JSON.parse(String(init.body)) : {};
    calls.push({ url, init, body });
    return Response.json(url.includes('oauth2.googleapis.com') ? { access_token: 'token', expires_in: 3600 } : url.endsWith('googleAds:search') ? { results: rows } : response);
  });
  return { provider: new GoogleAdsProvider(client, resolver), calls };
}
function operation(tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'create'): WriteOperation {
  return { tool, provider: 'google', accountId: account, kind, payload };
}
const mutations = (calls: Call[]) => calls.filter(call => call.url.endsWith('assets:mutate'));

describe('Google typed shared assets', () => {
  it('constructs all schemas lazily and does not advertise native asset deletion', () => {
    const provider = new Proxy({} as GoogleAdsProvider, { get() { throw new Error('Eager provider access'); } });
    const tools = googleTools(provider);
    expect(tools.some(tool => tool.name === 'google_upload_image_asset')).toBe(true);
    expect(tools.some(tool => /google_(delete|remove)_asset$/.test(tool.name))).toBe(false);
  });

  it('renders native account-owned image previews and shared rename actions with truthful truncation', async () => {
    const image = { id: assetId, resourceName: resource, name: 'Actual image', type: 'IMAGE', imageAsset: { fullSize: { url: 'https://tpc.googlesyndication.com/simgad/image' } } };
    const { provider, calls } = fixture([{ asset: image }, { asset: { ...image, id: '43', resourceName: `customers/${account}/assets/43` } }]);
    const result = await provider.assets.list({ account_id: account, asset_ids: [assetId, '43'], types: ['IMAGE'], limit: 1 });
    expect(result).toMatchObject({ truncated: true, creatives: [{ id: assetId, name: 'Actual image', media: [{ type: 'image', url: image.imageAsset.fullSize.url }], actions: [{ tool: 'google_rename_asset', arguments: { account_id: account, asset_id: assetId } }] }] });
    expect(calls.at(-1)!.body.query).toContain("asset.id IN (42,43) AND asset.type IN ('IMAGE') LIMIT 2");
    expect(result.assets).toEqual([image]);
    expect(mutations(calls)).toEqual([]);
  });

  it('omits untrusted preview origins and rejects a foreign native resource identity', async () => {
    const { provider } = fixture([{ asset: { ...asset, imageAsset: { fullSize: { url: 'https://example.com/pixel' } } } }]);
    expect((await provider.assets.list({ account_id: account, limit: 1 })).creatives[0]!.media).toEqual([]);
    const foreign = fixture([{ asset: { ...asset, resourceName: 'customers/9999999999/assets/42' } }]);
    await expect(foreign.provider.assets.list({ account_id: account, limit: 1 })).rejects.toThrow('invalid ID or account');
  });

  it('validates exact image bytes at preview and applies only the native create operation', async () => {
    const { provider, calls } = fixture([], media), op = operation('google_upload_image_asset', { name: 'QA image', media_id: '00000000-0000-4000-8000-000000000001', expected_sha256: sha });
    const preview = await provider.previewWrite(op, guard);
    expect(preview.serverValidated).toBe(true);
    expect(preview.changes.join(' ')).toContain(sha);
    expect(preview.changes.join(' ')).not.toContain(Buffer.from(bytes).toString('base64'));
    expect(mutations(calls)[0]!.body).toEqual({ validateOnly: true, partialFailure: false, operations: [{ create: { name: 'QA image', imageAsset: { data: Buffer.from(bytes).toString('base64') } } }] });
    expect(await provider.applyWrite(op, guard)).toEqual({ applied: true, resourceIds: [resource] });
    expect(mutations(calls)[1]!.body).toMatchObject({ validateOnly: false });
    expect(calls.some(call => /adGroupAds|campaigns/.test(call.url))).toBe(false);
  });

  it('rejects changed upload bytes before making a native mutation', async () => {
    const { provider, calls } = fixture([], media);
    await expect(provider.previewWrite(operation('google_upload_image_asset', { media_id: '00000000-0000-4000-8000-000000000001', expected_sha256: 'a'.repeat(64) }), guard)).rejects.toThrow('SHA-256 mismatch');
    expect(calls).toEqual([]);
  });

  it('references a native YouTube ID without uploading or publishing a video', async () => {
    const { provider, calls } = fixture();
    await provider.previewWrite(operation('google_create_youtube_asset', { name: 'Existing QA video', youtube_video_id: 'abcDEF012_-' }), guard);
    expect(mutations(calls)[0]!.body).toEqual({ validateOnly: true, partialFailure: false, operations: [{ create: { name: 'Existing QA video', youtubeVideoAsset: { youtubeVideoId: 'abcDEF012_-' } } }] });
    expect(calls).toHaveLength(2);
  });

  it.each([
    [{ type: 'CALLOUT', callout_text: 'Free delivery' }, { calloutAsset: { calloutText: 'Free delivery' } }],
    [{ type: 'STRUCTURED_SNIPPET', header: 'Types', values: ['A', 'B', 'C'] }, { structuredSnippetAsset: { header: 'Types', values: ['A', 'B', 'C'] } }],
    [{ type: 'SITELINK', link_text: 'Explore', final_urls: ['https://example.com'], description1: 'First', description2: 'Second' }, { finalUrls: ['https://example.com'], sitelinkAsset: { linkText: 'Explore', description1: 'First', description2: 'Second' } }],
  ])('creates an unattached extension with native fields: %j', async (content, create) => {
    const { provider, calls } = fixture();
    await provider.previewWrite(operation('google_create_extension_asset', { content }), guard);
    expect(mutations(calls)[0]!.body).toEqual({ validateOnly: true, partialFailure: false, operations: [{ create }] });
  });

  it('preserves omitted sitelink descriptions via exact masks and clears both when explicitly supplied empty', async () => {
    const { provider, calls } = fixture();
    const content = { type: 'SITELINK', link_text: 'New link', final_urls: ['https://new.example'] };
    await provider.previewWrite(operation('google_update_extension_asset', { asset_id: assetId, content }, 'update'), guard);
    expect(mutations(calls)[0]!.body.operations).toEqual([{ update: { resourceName: resource, finalUrls: ['https://new.example'], sitelinkAsset: { linkText: 'New link' } }, updateMask: 'final_urls,sitelink_asset.link_text' }]);
    await provider.previewWrite(operation('google_update_extension_asset', { asset_id: assetId, content: { ...content, description1: '', description2: '' } }, 'update'), guard);
    expect(mutations(calls)[1]!.body.operations).toEqual([{ update: { resourceName: resource, finalUrls: ['https://new.example'], sitelinkAsset: { linkText: 'New link', description1: '', description2: '' } }, updateMask: 'final_urls,sitelink_asset.link_text,sitelink_asset.description1,sitelink_asset.description2' }]);
  });

  it('refuses to change asset type or rename a foreign resource', async () => {
    const { provider, calls } = fixture();
    await expect(provider.previewWrite(operation('google_update_extension_asset', { asset_id: assetId, content: { type: 'CALLOUT', callout_text: 'New' } }, 'update'), guard)).rejects.toThrow('type does not match');
    expect(mutations(calls)).toEqual([]);
    const foreign = fixture([{ asset: { ...asset, resourceName: 'customers/9999999999/assets/42' } }]);
    await expect(foreign.provider.previewWrite(operation('google_rename_asset', { asset_id: assetId, name: 'New' }, 'update'), guard)).rejects.toThrow('not owned');
    expect(mutations(foreign.calls)).toEqual([]);
  });

  it('changes only the shared name and retains native IDs on a bad mutation receipt', async () => {
    const { provider, calls } = fixture();
    await provider.previewWrite(operation('google_rename_asset', { asset_id: assetId, name: 'New name' }, 'update'), guard);
    expect(mutations(calls)[0]!.body.operations).toEqual([{ update: { resourceName: resource, name: 'New name' }, updateMask: 'name' }]);
    const bad = fixture([], media, { results: [{ resourceName: 'customers/9999999999/assets/42' }] });
    await expect(bad.provider.applyWrite(operation('google_upload_image_asset', { file_path: '/tmp/qa.png', expected_sha256: sha }), guard)).rejects.toMatchObject({ details: { resource_ids: ['customers/9999999999/assets/42'] } });
    expect(mutations(bad.calls)).toHaveLength(1);
  });

  it('rejects incomplete description pairs at the shared registry boundary', async () => {
    const { provider, calls } = fixture();
    const runtime = await createContext({ providerModules: [{ provider, tools: googleTools(provider) }] });
    await expect(runtime.registry.call('google_create_extension_asset', { account_id: account, content: { type: 'SITELINK', link_text: 'Visit', final_urls: ['https://example.com'], description1: 'Only one' } }, runtime.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toEqual([]);
  });
});
