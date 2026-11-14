import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, verifyMedia, withProjectRouting, type MediaLibrary } from '@adport/core';
import { FileTikTokCatalogAccessStore, catalogGrant, TikTokClient, TikTokAdsProvider, tiktokTools } from '@adport/provider-tiktok';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Real registry/SDK transport plus synthetic host bridges; no native account or actual host claim.
describe('TikTok catalog-video SDK/widget contracts', () => {
  it.each(['openai', 'mcp'] as const)('keeps catalog scope, loaded players and guarded file/removal flows on the %s bridge', async bridge => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-catalog-videos-ui-'));
    const account = '7111000000000000001', bc = '111', catalog = '222', job = '9007199254740993', project = 'b310e750-d001-4427-8184-09bd05920e01', mediaId = '11111111-1111-4111-8111-111111111111';
    const scope = { account_id: account, bc_id: bc, catalog_id: catalog }, args = { ...scope, project_id: project, page: 1, page_size: 1 };
    const grantScope = { accountId: account, businessId: bc, resourceId: catalog, kind: 'catalog' as const }, store = new FileTikTokCatalogAccessStore(join(dir, 'grants'));await store.compareAndSet(grantScope, catalogGrant(grantScope).hash, 'write');
    let videos = ['first-composite_id', 'second-composite_id', 'third-composite_id'].map(id => ({ catalog_video_id: id, video_name: id + ' <script>globalThis.executed=true</script>', video_link: 'https://source.example/video.mp4?token=PRIVATE-VIDEO', sku_id_list: ['00012'], description: 'Original copy', status: 'SUCCESS', active_status: 'ACTIVATED', preview_url: 'https://v16-tiktokcdn-com.akamaized.net/' + id + '.mp4' }));
    const csv = Buffer.from('video_name,video_link,sku_id_list\r\nQA,https://source.example/video.mp4?token=PRIVATE-VIDEO,00012\r\n'), hash = createHash('sha256').update(csv).digest('hex');let writes = 0, staging = 0;
    const media: MediaLibrary = { list: async () => ({ assets: [], truncated: false }), read: async (source, options) => verifyMedia(csv, 'Catalog videos.csv', source.expected_sha256, options), providerUrl: async () => { staging++;return { url: 'https://storage.example/videos.csv?token=PRIVATE-CSV', sha256: hash, expires_at: new Date(Date.now() + 3600_000).toISOString() }; } };
    const client = new TikTokClient({ accessToken: 'inert' }, async (raw, init = {}) => {
      const url = new URL(String(raw)), ok = (data: unknown) => Response.json({ code: 0, data });
      if (url.pathname.endsWith('/catalog/get/')) return ok({ list: [{ catalog_id: catalog, catalog_name: 'QA', catalog_type: 'ECOM', bc_info: { bc_id: bc }, catalog_conf: { is_multi_country: false } }] });
      if (url.pathname.endsWith('/catalog/product/get/')) return ok({ list: [{ sku_id: '00012', product_id: '42', ad_creation_eligible: 'AVAILABLE' }], page_info: { page: 1, page_size: 500, total_page: 1, total_number: 1 } });
      if (url.pathname.endsWith('/catalog/video/get/')) {
        const ids = url.searchParams.has('catalog_video_ids') ? JSON.parse(url.searchParams.get('catalog_video_ids')!) : undefined, page = Number(url.searchParams.get('page') ?? 1), size = Number(url.searchParams.get('page_size') ?? 20);
        return ok(ids ? { videos: videos.filter(row => ids.includes(row.catalog_video_id)) } : { videos: videos.slice((page - 1) * size, page * size), page_info: { page, page_size: size, total_number: videos.length, total_page: Math.ceil(videos.length / size) } });
      }
      if (url.pathname.endsWith('/catalog/video/log/')) return ok({ video_feed_log: { catalog_id: catalog, feed_id: '333', process_status: 'PROCESSING', error_count: 0 } });
      if (init.method === 'POST') {
        writes++;const body = JSON.parse(String(init.body));
        if (url.pathname.endsWith('/catalog/video/file/')) { expect(body).toEqual({ bc_id: bc, catalog_id: catalog, file_url: 'https://storage.example/videos.csv?token=PRIVATE-CSV' });return ok({ feed_log_id: job }); }
        if (url.pathname.endsWith('/catalog/video/delete/')) { videos = videos.filter(row => !body.catalog_video_ids.includes(row.catalog_video_id));return ok({}); }
      }
      throw new Error('Unexpected fixture endpoint');
    });
    const provider = new TikTokAdsProvider(client, { appId: 'inert', secret: 'inert' }, media, store), base = await createContext({ media, engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: tiktokTools(provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['tiktok'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'catalog-video-widget', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const callTool = vi.fn(async (name: string, arguments_: Record<string, unknown>) => host.callTool({ name, arguments: arguments_ }));
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test/', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
      };
      const definitions = (await host.listTools()).tools;for (const name of ['tiktok_catalog_videos', 'tiktok_catalog_video_log', 'tiktok_catalog_video_import_context', 'tiktok_upload_catalog_videos', 'tiktok_delete_catalog_video']) expect(definitions.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      const response = await host.callTool({ name: 'tiktok_catalog_videos', arguments: args });expect(response.isError).not.toBe(true);expect(JSON.stringify(response)).not.toContain('PRIVATE-VIDEO');
      const gallery = mount(response), grid = gallery.querySelector<HTMLElement>('[data-provider-gallery]')!, first = gallery.querySelector('video')!;first.currentTime = 7;grid.scrollTop = 60;
      expect(gallery.textContent).toContain('<script>');expect(Reflect.get(gallery.ownerDocument.defaultView!, 'executed')).toBeUndefined();
      gallery.querySelector<HTMLButtonElement>('[data-provider-more]')!.click();await vi.waitFor(() => expect(gallery.querySelectorAll('article')).toHaveLength(2));
      expect(callTool).toHaveBeenLastCalledWith('tiktok_catalog_videos', { ...args, page: 2 });expect(gallery.querySelector('video')).toBe(first);expect(first.currentTime).toBe(7);expect(grid.scrollTop).toBe(60);
      const second = gallery.querySelectorAll('video')[1]!;second.currentTime = 4;
      gallery.querySelector<HTMLButtonElement>('[data-creative-action]')!.click();await vi.waitFor(() => expect(gallery.querySelector('[data-approve]')).not.toBeNull());expect(writes).toBe(0);
      const previewCall = callTool.mock.calls.at(-1)!;expect(previewCall[0]).toBe('tiktok_delete_catalog_video');expect(previewCall[1]).toEqual({ ...scope, project_id: project, catalog_video_id: 'first-composite_id', expected_configuration_hash: expect.any(String), acknowledge_shared_effects: true });expect(previewCall[1]).not.toHaveProperty('pending_operation_id');
      gallery.querySelector<HTMLButtonElement>('[data-approve]')!.dispatchEvent(new gallery.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      await vi.waitFor(() => expect(writes).toBe(1), { timeout: 2500 });await vi.waitFor(() => expect(gallery.querySelector('.operation-status')?.textContent).toBe('Applied'));
      gallery.querySelector<HTMLButtonElement>('[aria-label="Back to creatives"]')!.click();await vi.waitFor(() => expect(gallery.querySelectorAll('article')).toHaveLength(1));expect(gallery.querySelector('video')).toBe(second);expect(second.currentTime).toBe(4);expect(grid.scrollTop).toBe(60);
      // Deletion shifts native offset pages. Restart at the refreshed continuation, retaining loaded players.
      gallery.querySelector<HTMLButtonElement>('[data-provider-more]')!.click();await vi.waitFor(() => expect(gallery.querySelectorAll('article')).toHaveLength(2));expect(gallery.querySelectorAll('video')[1]!.getAttribute('src')).toContain('third-composite_id');expect(gallery.querySelector('video')).toBe(second);
      const contextResponse = await host.callTool({ name: 'tiktok_catalog_video_import_context', arguments: { ...scope, project_id: project, media_id: mediaId, expected_sha256: hash } });expect(contextResponse.isError).not.toBe(true);const context = contextResponse.structuredContent as any;
      const uploadArgs = { ...scope, project_id: project, media_id: mediaId, expected_sha256: hash, expected_catalog_hash: context.expected_catalog_hash, expected_associations_hash: context.expected_associations_hash, acknowledge_shared_effects: true, acknowledge_possible_delivery: true, acknowledge_async_processing: true }, uploadPreview = await host.callTool({ name: 'tiktok_upload_catalog_videos', arguments: uploadArgs });expect(uploadPreview.isError).not.toBe(true);expect(staging).toBe(0);expect(writes).toBe(1);
      const upload = mount(uploadPreview);expect(upload.textContent).toContain('Upload catalog videos');expect(upload.textContent).toContain('existing Video Shopping Ads');const approval = upload.querySelector<HTMLButtonElement>('[data-approve]')!;expect(approval).not.toBeNull();approval.dispatchEvent(new upload.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      await vi.waitFor(() => expect(writes).toBe(2), { timeout: 2500 });await vi.waitFor(() => expect(upload.querySelector('.operation-status')?.textContent).toBe('Processing pending'));expect(staging).toBe(1);
      expect(callTool).toHaveBeenLastCalledWith('tiktok_upload_catalog_videos', expect.objectContaining({ ...uploadArgs, pending_operation_id: expect.any(String) }));expect(upload.textContent).toContain('Processing is not confirmed');expect(JSON.stringify({ response, contextResponse, uploadPreview })).not.toContain('PRIVATE-');
      const grant = await store.get(grantScope);await store.compareAndSet(grantScope, grant.hash, 'read');const readOnly = mount(await host.callTool({ name: 'tiktok_catalog_videos', arguments: args }));expect(readOnly.querySelector('[data-creative-action]')).toBeNull();expect(readOnly.querySelector('[data-provider-more]')).not.toBeNull();
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  });
});
