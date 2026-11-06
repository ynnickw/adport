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

describe('TikTok catalog product SDK/widget contracts', () => {
  it.each(['openai', 'mcp'] as const)('retains gallery players across pages through %s and renders asynchronous import receipts', async bridge => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-catalog-products-widget-'));
    const account = '7678335757387513873', bc = '111', catalog = '222', feed = '333', job = '9007199254740993', project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0', mediaId = '11111111-1111-4111-8111-111111111111';
    const selected = { project_id: project, account_id: account, bc_id: bc, catalog_id: catalog };
    const bytes = Buffer.from('template_column_a,template_column_b\nfirst,Sample\n'), sha256 = createHash('sha256').update(bytes).digest('hex');
    const privateUrl = 'https://store.example/private.csv?token=PRIVATE-CAPABILITY';
    const store = new FileTikTokCatalogAccessStore(join(dir, 'grants')), scope = { accountId: account, businessId: bc, resourceId: catalog, kind: 'catalog' as const };
    await store.compareAndSet(scope, catalogGrant(scope).hash, 'write');
    let writes = 0, importMode = 'INCREASE';
    const media: MediaLibrary = { list: async () => ({ assets: [], truncated: false }), read: async (source, options) => verifyMedia(bytes, 'catalog.csv', source.expected_sha256, options), providerUrl: async () => ({ url: privateUrl, sha256, expires_at: new Date(Date.now() + 3600_000).toISOString() }) };
    const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert' }, async (raw, init = {}) => {
      const url = new URL(String(raw));
      if (url.pathname.endsWith('/catalog/get/')) return Response.json({ code: 0, data: { list: [{ catalog_id: catalog, catalog_name: 'QA', catalog_type: 'ECOM', bc_info: { bc_id: bc }, catalog_conf: {} }] } });
      if (url.pathname.endsWith('/catalog/feed/get/')) return Response.json({ code: 0, data: { feed_list: [{ feed_id: feed, feed_name: 'QA', feed_type: 'DATA_FEED', status: 'OFF', last_update_param: { update_mode: 'INCREMENTAL' } }] } });
      if (url.pathname.endsWith('/catalog/product/get/')) {
        const page = Number(url.searchParams.get('page'));
        return Response.json({ code: 0, data: { list: [{ product_id: String(page), sku_id: 'sku-' + page, title: page === 1 ? 'First <script>globalThis.executed=true</script>' : 'Second product', video_url: 'https://v16-tiktokcdn-com.akamaized.net/product-' + page + '.mp4' }], page_info: { page, page_size: 1, total_number: 2, total_page: 2 } } });
      }
      if (url.pathname.endsWith('/catalog/product/file/')) { writes++;importMode = JSON.parse(String(init.body)).update_mode === 'OVERWRITE' ? 'REPLACE' : 'INCREASE';return Response.json({ code: 0, data: { feed_log_id: job } }); }
      if (url.pathname.endsWith('/catalog/product/log/')) return Response.json({ code: 0, data: { product_feed_log: { catalog_id: catalog, feed_id: feed, process_status: 'PROCESSING', update_mode: importMode, add_count: 1, error_count: 0 } } });
      throw new Error('Unexpected fixture endpoint');
    }), { appId: 'inert', secret: 'inert' }, media, store);
    const base = await createContext({ media, engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: tiktokTools(provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['tiktok'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'catalog-products-widget', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => host.callTool({ name, arguments: args }));
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test/', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(value => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result: value } }))); });
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
      };
      const resource = (await host.readResource({ uri: ADPORT_UI_URI })).contents[0]!;
      expect(resource._meta?.ui).toMatchObject({ csp: { resourceDomains: expect.arrayContaining(['https://p16-sign-sg.tiktokcdn.com', 'https://v16-tiktokcdn-com.akamaized.net']) } });
      const tools = (await host.listTools()).tools;
      for (const name of ['tiktok_catalog_products', 'tiktok_catalog_product_log', 'tiktok_import_catalog_file']) expect(tools.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      const initial = await host.callTool({ name: 'tiktok_catalog_products', arguments: { ...selected, page_size: 1 } });expect(initial.isError).not.toBe(true);
      const main = mount(initial), gallery = main.querySelector<HTMLElement>('[data-provider-gallery]')!, player = gallery.querySelector('video')!;
      player.currentTime = 8;gallery.scrollTop = 25;
      expect(main.textContent).toContain('First <script>');expect(Reflect.get(main.ownerDocument.defaultView!, 'executed')).toBeUndefined();
      main.querySelector<HTMLButtonElement>('[data-provider-more]')!.click();await vi.waitFor(() => expect(main.textContent).toContain('Second product'));
      expect(gallery.querySelector('video')).toBe(player);expect(player.currentTime).toBe(8);expect(gallery.scrollTop).toBe(25);
      expect(callTool).toHaveBeenCalledWith('tiktok_catalog_products', expect.objectContaining({ ...selected, page_size: 1, page: 2 }));
      const parent = await host.callTool({ name: 'tiktok_get_catalog', arguments: selected }), feeds = await host.callTool({ name: 'tiktok_catalog_feeds', arguments: { ...selected, feed_id: feed } });
      const args = { ...selected, feed_id: feed, media_id: mediaId, expected_sha256: sha256,
        expected_catalog_hash: (parent.structuredContent as any).catalog.configuration_hash, expected_feed_hash: (feeds.structuredContent as any).feeds[0].configuration_hash,
        update_mode: 'OVERWRITE', acknowledge_overwrite: true, acknowledge_shared_effects: true, acknowledge_async_processing: true };
      const preview = await host.callTool({ name: 'tiktok_import_catalog_file', arguments: args });expect(preview.isError).not.toBe(true);
      const review = mount(preview);expect(review.textContent).toContain('OVERWRITE removes existing');expect(review.textContent).toContain('not completed ingestion');expect(review.querySelector('[data-approve]')).not.toBeNull();expect(writes).toBe(0);
      const pending = (preview.structuredContent as any).pending_operation_id;
      const applied = await host.callTool({ name: 'tiktok_import_catalog_file', arguments: { ...args, pending_operation_id: pending } });expect(applied.isError).not.toBe(true);expect(writes).toBe(1);
      const receipt = mount(applied);expect(receipt.querySelector('.operation-status')?.textContent).toBe('Processing pending');expect(receipt.textContent).toContain('Accepted for processing. Processing is not confirmed.');
      expect(JSON.stringify({ preview, applied })).not.toContain('PRIVATE-CAPABILITY');
      const log = await host.callTool({ name: 'tiktok_catalog_product_log', arguments: { ...selected, feed_id: feed, feed_log_id: job } });expect(log.isError).not.toBe(true);
      const status = mount(log);expect(status.querySelector('article strong')?.textContent).toBe('Product import');expect(status.textContent).toContain('PROCESSING');
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  });
});
