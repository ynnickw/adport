import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { FileTikTokCatalogAccessStore, catalogGrant, TikTokClient, TikTokAdsProvider, tiktokTools } from '@adport/provider-tiktok';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Actual registry/SDK transport; synthetic host bridges do not establish live host/provider success.
describe('TikTok catalog event-source SDK/widget contracts', () => {
  it.each(['openai', 'mcp'] as const)('pages advertiser apps and reviews/applies both source kinds through %s', async bridge => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-catalog-event-ui-')), account = '7678335757387513873', bc = '111', catalog = '222', appId = '9007199254740993', pixelCode = 'C_NATIVE_PIXEL', project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0';
    const scope = { account_id: account, bc_id: bc, catalog_id: catalog, project_id: project }, resource = { accountId: account, businessId: bc, resourceId: catalog, kind: 'catalog' as const }, store = new FileTikTokCatalogAccessStore(join(dir, 'grants'));await store.compareAndSet(resource, catalogGrant(resource).hash, 'write');
    const apps = [appId, '111'].map(id => ({ advertiser_id: account, app_id: id, app_name: 'App <script>globalThis.executed=true</script> ' + id, app_platform_id: 'com.example.' + id, platform: 'ANDROID', partner: { partner_token: 'PRIVATE-PARTNER' }, tracking_url: { click_url: 'https://tracking.example/?token=PRIVATE-TRACKING' } }));
    let sources: Array<{ app_id?: string | null; pixel_code?: string | null; event_source_name: string }> = [{ app_id: '222', pixel_code: null, event_source_name: 'Unrelated source' }];const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert' }, async (raw, init = {}) => {
      const url = new URL(String(raw)), ok = (data: unknown) => Response.json({ code: 0, data });
      if (url.pathname.endsWith('/catalog/get/')) return ok({ list: [{ catalog_id: catalog, catalog_name: 'QA', catalog_type: 'ECOM', bc_info: { bc_id: bc }, catalog_conf: {} }] });
      if (url.pathname.endsWith('/catalog/eventsource_bind/get/')) return ok({ catalog_id: catalog, event_sources: sources });
      if (url.pathname.endsWith('/app/list/')) return ok({ apps });
      if (url.pathname.endsWith('/app/info/')) return ok({ app: apps.find(app => app.app_id === url.searchParams.get('app_id')) });
      if (url.pathname.endsWith('/pixel/list/')) return ok({ pixels: [{ pixel_id: '42', pixel_code: pixelCode, pixel_name: 'Pixel QA', pixel_script: 'PRIVATE-SCRIPT' }], page_info: { page: 1, page_size: 20, total_number: 1, total_page: 1 } });
      if (init.method === 'POST' && /\/catalog\/eventsource\/(bind|unbind)\/$/.test(url.pathname)) {
        const body = JSON.parse(String(init.body));posts.push({ path: url.pathname, body });expect(body).toEqual({ advertiser_id: account, bc_id: bc, catalog_id: catalog, app_id: appId, pixel_code: pixelCode });
        if (url.pathname.endsWith('/bind/')) sources.push({ app_id: appId, pixel_code: pixelCode, event_source_name: 'Combined native source row' });else sources = sources.filter(source => source.app_id !== appId && source.pixel_code !== pixelCode);return ok({});
      }
      throw new Error('Unexpected native fixture call');
    }), { appId: 'inert', secret: 'inert' }, undefined, store);
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: tiktokTools(provider) }] }), runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['tiktok'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'catalog-event-source-widget', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => host.callTool({ name, arguments: args }));
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test/', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
      };
      const tools = (await host.listTools()).tools;for (const name of ['tiktok_catalog_event_sources', 'tiktok_catalog_event_source_apps', 'tiktok_catalog_event_source_context', 'tiktok_bind_catalog_event_sources', 'tiktok_unbind_catalog_event_sources']) expect(tools.find(t => t.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      const initial = await host.callTool({ name: 'tiktok_catalog_event_source_apps', arguments: { ...scope, page_size: 1 } });expect(initial.isError).not.toBe(true);expect(JSON.stringify(initial)).not.toContain('PRIVATE-');const gallery = mount(initial), list = gallery.querySelector<HTMLElement>('[data-record-list]')!, first = list.querySelector('article')!;list.scrollTop = 42;
      gallery.querySelector<HTMLButtonElement>('[data-record-more]')!.click();await vi.waitFor(() => expect(list.querySelectorAll('article')).toHaveLength(2));expect(list.querySelector('article')).toBe(first);expect(list.scrollTop).toBe(42);expect(callTool).toHaveBeenLastCalledWith('tiktok_catalog_event_source_apps', expect.objectContaining({ ...scope, page_size: 1, cursor: expect.any(String) }));expect(Reflect.get(gallery.ownerDocument.defaultView!, 'executed')).toBeUndefined();
      for (const purpose of ['bind', 'unbind'] as const) {
        const context = await host.callTool({ name: 'tiktok_catalog_event_source_context', arguments: { ...scope, app_id: appId, pixel_code: pixelCode, purpose } });expect(context.isError).not.toBe(true);expect(JSON.stringify(context)).not.toContain('PRIVATE-');const data = context.structuredContent as any;
        const args = { ...scope, app_id: appId, pixel_code: pixelCode, expected_catalog_hash: data.expected_catalog_hash, expected_bindings_hash: data.expected_bindings_hash, expected_sources_hash: data.expected_sources_hash, acknowledge_shared_effects: true, acknowledge_measurement_effects: true }, name = purpose === 'bind' ? 'tiktok_bind_catalog_event_sources' : 'tiktok_unbind_catalog_event_sources', preview = await host.callTool({ name, arguments: args });expect(preview.isError).not.toBe(true);
        const review = mount(preview);expect(review.textContent).toContain(purpose === 'bind' ? 'Bind catalog event sources' : 'Unbind catalog event sources');expect(review.textContent).toContain('Web Pixel');expect(review.textContent).toContain('App event source');expect(review.textContent).toContain('Other bindings preserved');expect(review.textContent).toContain('existing ads');expect(posts).toHaveLength(purpose === 'bind' ? 0 : 1);
        const apply = review.querySelector<HTMLButtonElement>('[data-approve]')!;expect(apply).not.toBeNull();apply.dispatchEvent(new review.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(review.querySelector('.operation-status')?.textContent).toBe('Applied'), { timeout: 3000 });expect(callTool).toHaveBeenLastCalledWith(name, expect.objectContaining({ ...args, pending_operation_id: expect.any(String) }));
      }
      expect(posts.map(post => post.path)).toEqual(['/open_api/v1.3/catalog/eventsource/bind/', '/open_api/v1.3/catalog/eventsource/unbind/']);expect(sources).toEqual([{ app_id: '222', pixel_code: null, event_source_name: 'Unrelated source' }]);
      const bindings = await host.callTool({ name: 'tiktok_catalog_event_sources', arguments: scope });expect(bindings.isError).not.toBe(true);expect(mount(bindings).textContent).toContain('Unrelated source');const currentGrant = await store.get(resource);await store.compareAndSet(resource, currentGrant.hash, 'read');const context = await host.callTool({ name: 'tiktok_catalog_event_source_context', arguments: { ...scope, app_id: appId, pixel_code: pixelCode } }), data = context.structuredContent as any;
      const denied = await host.callTool({ name: 'tiktok_bind_catalog_event_sources', arguments: { ...scope, app_id: appId, pixel_code: pixelCode, expected_catalog_hash: data.expected_catalog_hash, expected_bindings_hash: data.expected_bindings_hash, expected_sources_hash: data.expected_sources_hash, acknowledge_shared_effects: true, acknowledge_measurement_effects: true } });expect(denied.isError).toBe(true);expect(mount(denied).querySelector('[data-approve]')).toBeNull();expect(posts).toHaveLength(2);
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  });
});
