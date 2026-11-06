import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { FileTikTokCatalogAccessStore, catalogGrant, creationScope, TikTokClient, TikTokAdsProvider, tiktokTools } from '@adport/provider-tiktok';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Real registry/SDK transport and synthetic host bridges, not actual native/Claude/ChatGPT verification.
describe('TikTok catalog lifecycle SDK/widgets', () => {
  it.each(['openai', 'mcp'] as const)('reviews immutable creation, adopts only its native ID and confirms permanent deletion through %s', async bridge => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-catalog-lifecycle-ui-')), account = '7678335757387513873', bc = '111', catalogId = '9007199254740993', project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0', scope = { account_id: account, bc_id: bc, project_id: project };
    const store = new FileTikTokCatalogAccessStore(join(dir, 'grants')), delegation = creationScope(account, bc);await store.compareAndSet(delegation, catalogGrant(delegation).hash, 'create');let catalog: Record<string, unknown> | undefined;const posts: string[] = [];
    const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert' }, async (raw, init = {}) => {
      const url = new URL(String(raw)), ok = (data: unknown) => Response.json({ code: 0, data });
      if (url.pathname.endsWith('/catalog/available_country/get/')) return ok({ region_codes: ['DE', 'US'] });
      if (url.pathname.endsWith('/catalog/get/')) { expect(url.searchParams.get('catalog_id')).toBe(catalogId);return ok({ list: catalog ? [catalog] : [], page_info: { page: 1, total_page: 1, total_number: catalog ? 1 : 0 } }); }
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body));posts.push(url.pathname);
        if (url.pathname.endsWith('/catalog/create/')) { expect(body).toEqual({ bc_id: bc, name: 'QA <script>globalThis.executed=true</script>', catalog_type: 'ECOM', catalog_conf: { currency: 'EUR', region_code: 'DE', is_multi_country: false, channel: 'PARTNER' } });catalog = { catalog_id: catalogId, catalog_name: body.name, catalog_type: 'ECOM', bc_info: { bc_id: bc }, catalog_conf: { currency: 'EUR', country: 'DE', is_multi_country: false, channel: 'PARTNER' } };return ok({ catalog_id: catalogId }); }
        if (url.pathname.endsWith('/catalog/delete/')) { expect(body).toEqual({ bc_id: bc, catalog_id: catalogId });catalog = undefined;return ok({ catalog_id: catalogId }); }
      }
      throw new Error('Unexpected fixture endpoint');
    }), { appId: 'inert', secret: 'inert' }, undefined, store), base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: tiktokTools(provider) }] }), runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['tiktok'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'catalog-lifecycle-widget', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => host.callTool({ name, arguments: args }));
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test/', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
      };
      const tools = (await host.listTools()).tools;for (const name of ['tiktok_catalog_creation_context', 'tiktok_create_catalog', 'tiktok_delete_catalog']) expect(tools.find(t => t.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);expect(tools.find(t => t.name === 'tiktok_set_catalog_access')).toBeUndefined();expect(tools.find(t => t.name === 'tiktok_catalog_access_snapshot')).toBeUndefined();
      const context = await host.callTool({ name: 'tiktok_catalog_creation_context', arguments: scope });expect(context.isError).not.toBe(true);const data = context.structuredContent as any, args = { ...scope, name: 'QA <script>globalThis.executed=true</script>', catalog_type: 'ECOM', catalog_conf: { currency: 'EUR', region_code: 'DE', is_multi_country: false, channel: 'PARTNER' }, expected_creation_access_hash: data.expected_creation_access_hash, expected_regions_hash: data.expected_regions_hash, acknowledge_new_catalog_management: true }, preview = await host.callTool({ name: 'tiktok_create_catalog', arguments: args });expect(preview.isError).not.toBe(true);
      const review = mount(preview);expect(review.textContent).toContain('cannot be edited later');expect(review.textContent).toContain('New catalog project access');expect(review.textContent).toContain('PARTNER');expect(posts).toHaveLength(0);expect(Reflect.get(review.ownerDocument.defaultView!, 'executed')).toBeUndefined();const hold = review.querySelector<HTMLButtonElement>('[data-approve]')!;expect(hold).not.toBeNull();hold.dispatchEvent(new review.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(review.querySelector('.operation-status')?.textContent).toBe('Applied'), { timeout: 3000 });expect(callTool).toHaveBeenLastCalledWith('tiktok_create_catalog', expect.objectContaining({ ...args, pending_operation_id: expect.any(String) }));
      const current = await host.callTool({ name: 'tiktok_get_catalog', arguments: { ...scope, catalog_id: catalogId } });expect(current.isError).not.toBe(true);const configuration = (current.structuredContent as any).catalog;
      const removal = await host.callTool({ name: 'tiktok_delete_catalog', arguments: { ...scope, catalog_id: catalogId, expected_configuration_hash: configuration.configuration_hash, confirm_catalog_name: configuration.catalog_name, acknowledge_shared_effects: true, acknowledge_delete_products_and_feeds: true } });expect(removal.isError).not.toBe(true);const deletion = mount(removal);expect(deletion.textContent).toContain('Delete catalog permanently');expect(deletion.textContent).toContain('All current products and feeds');expect(deletion.textContent).toContain('not enumerated or frozen');deletion.querySelector<HTMLButtonElement>('[data-approve]')!.dispatchEvent(new deletion.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(deletion.querySelector('.operation-status')?.textContent).toBe('Applied'), { timeout: 3000 });expect(posts).toEqual(['/open_api/v1.3/catalog/create/', '/open_api/v1.3/catalog/delete/']);expect((await store.get({ accountId: account, businessId: bc, resourceId: catalogId, kind: 'catalog' })).mode).toBe('write');
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  });
});
