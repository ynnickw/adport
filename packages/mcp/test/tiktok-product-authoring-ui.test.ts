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

describe('TikTok product authoring SDK/widget contracts', () => {
  it.each(['openai', 'mcp'] as const)('shows safe agent reviews and applies removal through the %s widget bridge', async bridge => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-tiktok-product-authoring-ui-'));
    const account = '7111000000000000001', bc = '111', catalog = '222', feed = '333', productId = '9007199254740993', job = '9007199254740994', project = 'b310e750-d001-4427-8184-09bd05920e01';
    const scope = { account_id: account, bc_id: bc, catalog_id: catalog }, args = { ...scope, feed_id: feed, project_id: project };
    const store = new FileTikTokCatalogAccessStore(join(dir, 'grants')), grantScope = { accountId: account, businessId: bc, resourceId: catalog, kind: 'catalog' as const };await store.compareAndSet(grantScope, catalogGrant(grantScope).hash, 'write');
    const product = { product_id: productId, sku_id: '00012', title: 'Product <script>globalThis.executed=true</script>', description: 'Original', image_url: 'https://images.example/private.jpg?token=PRIVATE-CAPABILITY' };let writes = 0;
    const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert' }, async (raw, init = {}) => {
      const url = new URL(String(raw)), ok = (data: unknown) => Response.json({ code: 0, data });
      if (url.pathname.endsWith('/catalog/get/')) return ok({ list: [{ catalog_id: catalog, catalog_name: 'QA', catalog_type: 'ECOM', bc_info: { bc_id: bc }, catalog_conf: {} }] });
      if (url.pathname.endsWith('/catalog/feed/get/')) return ok({ feed_list: [{ feed_id: feed, feed_name: 'QA', feed_type: 'DATA_FEED', status: 'OFF' }] });
      if (url.pathname.endsWith('/catalog/product/get/')) return ok({ list: [product], page_info: { page: 1, page_size: 100, total_number: 1, total_page: 1 } });
      if (url.pathname.endsWith('/catalog/product/log/')) return ok({ product_feed_log: { catalog_id: catalog, feed_id: feed, process_status: 'PROCESSING', error_count: 0 } });
      if (init.method === 'POST' && /\/catalog\/product\/(update|delete)\/$/.test(url.pathname)) { writes++;return ok({ feed_log_id: job }); }
      throw new Error('Unexpected fixture endpoint');
    }), { appId: 'inert', secret: 'inert' }, undefined, store);
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: tiktokTools(provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['tiktok'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'product-authoring-widget', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => host.callTool({ name, arguments: args }));
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test/', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
      };
      const definitions = (await host.listTools()).tools;
      for (const name of ['tiktok_catalog_product_schema', 'tiktok_catalog_product_context', 'tiktok_upsert_catalog_products', 'tiktok_update_catalog_products', 'tiktok_delete_catalog_products']) expect(definitions.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      const response = await host.callTool({ name: 'tiktok_catalog_product_context', arguments: { ...args, product_ids: [productId] } });expect(response.isError).not.toBe(true);
      const context = response.structuredContent as any, records = mount(response);expect(records.textContent).toContain('Product <script>');expect(Reflect.get(records.ownerDocument.defaultView!, 'executed')).toBeUndefined();expect(JSON.stringify(response)).not.toContain('PRIVATE-CAPABILITY');
      const common = { ...args, catalog_type: 'ECOM', expected_catalog_hash: context.expected_catalog_hash, expected_feed_hash: context.expected_feed_hash, expected_products_hash: context.products_hash, acknowledge_shared_effects: true, acknowledge_async_processing: true };
      const update = { ...common, updates: [{ product_id: productId, fields: { title: 'Edited by agent' } }] }, preview = await host.callTool({ name: 'tiktok_update_catalog_products', arguments: update });expect(preview.isError).not.toBe(true);
      const review = mount(preview);expect(review.textContent).toContain('Edit catalog products');expect(review.textContent).toContain('Edited by agent');expect(review.querySelector('[data-approve]')).toBeNull();expect(writes).toBe(0);
      const applied = await host.callTool({ name: 'tiktok_update_catalog_products', arguments: { ...update, pending_operation_id: (preview.structuredContent as any).pending_operation_id } });expect(applied.isError).not.toBe(true);expect(writes).toBe(1);
      expect(mount(applied).querySelector('.operation-status')?.textContent).toBe('Processing pending');
      const remove = await host.callTool({ name: 'tiktok_delete_catalog_products', arguments: { ...common, product_ids: [productId], acknowledge_removal: true } });expect(remove.isError).not.toBe(true);
      const removal = mount(remove), button = removal.querySelector<HTMLButtonElement>('[data-approve]')!;expect(button).not.toBeNull();
      button.dispatchEvent(new removal.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      await vi.waitFor(() => expect(writes).toBe(2), { timeout: 2500 });
      await vi.waitFor(() => expect(removal.querySelector('.operation-status')?.textContent).toBe('Processing pending'));
      expect(callTool).toHaveBeenCalledWith('tiktok_delete_catalog_products', expect.objectContaining({ project_id: project, account_id: account, product_ids: [productId], pending_operation_id: expect.any(String) }));
      expect(JSON.stringify({ preview, applied, remove })).not.toContain('PRIVATE-CAPABILITY');
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  });
});
