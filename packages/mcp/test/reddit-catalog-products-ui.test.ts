import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { redditTools } from '../../reddit/src/tools.js';
import { productFixture, newProduct, productScope } from '../../reddit/test/catalog-products-fixture.js';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Real MCP SDK, project routing and pending gate; synthetic OpenAI/MCP host bridges.
// These checks do not establish actual Claude or ChatGPT execution.
describe('Reddit manual product SDK/widgets', () => {
  it.each(['openai', 'mcp'] as const)('reviews and applies scoped product creation/edit/deletion via %s', async bridge => {
    const f = await productFixture(), project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0', scope = { project_id: project, ...productScope };
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(f.dir, 'pending')), new AuditLog(join(f.dir, 'audit'))), providerModules: [{ provider: f.provider, tools: redditTools(f.provider) }] }), runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['reddit'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'reddit-products-widget-qa', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    const call = async (name: string, args: Record<string, unknown>) => { const result = await host.callTool({ name, arguments: args });expect(result.isError).not.toBe(true);return result; }, callTool = vi.fn(call);
    const mount = (result: unknown) => {
      const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
      if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
    };
    try {
      const tools = (await host.listTools()).tools;for (const name of ['reddit_catalog_product_context', 'reddit_create_catalog_products', 'reddit_update_catalog_products', 'reddit_delete_catalog_products']) expect(tools.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      const product = { ...newProduct(), title: 'QA <script>globalThis.executed=true</script>', brand: 'Preserved brand' }, context = async () => { const result = await call('reddit_catalog_product_context', { ...scope, product_ids: [product.id] });return result.structuredContent as { selection_hash: string }; };
      const reviewApply = async (tool: string, payload: Record<string, unknown>, text: string[]) => {
        const args = { ...scope, expected_selection_hash: (await context()).selection_hash, acknowledge_shared_effects: true, ...payload }, before = f.writes().length, result = await call(tool, args);expect(f.writes()).toHaveLength(before);const view = mount(result);
        for (const value of text) expect(view.textContent).toContain(value);expect(Reflect.get(view.ownerDocument.defaultView!, 'executed')).toBeUndefined();
        view.querySelector<HTMLButtonElement>('[data-approve]')!.dispatchEvent(new view.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(view.querySelector('.operation-status')?.textContent).toBe('Applied with warnings'), { timeout: 3000 });expect(callTool).toHaveBeenLastCalledWith(tool, expect.objectContaining({ ...args, pending_operation_id: expect.any(String) }));expect(f.writes()).toHaveLength(before + 1);
      };
      const before = mount(await call('reddit_catalog_product_context', { ...scope, product_ids: [product.id] }));expect(before.textContent).toContain('Absent');
      await reviewApply('reddit_create_catalog_products', { products: [product] }, ['Create catalog products', '19.99 EUR', 'QA <script>globalThis.executed=true</script>']);
      await reviewApply('reddit_update_catalog_products', { products: [{ id: product.id, title: 'Edited product', custom_label_0: 'Meta Ads' }] }, ['Update catalog products', 'Edited product', 'Preserved brand']);
      expect(f.state.products.find(row => row.id === product.id)).toMatchObject({ title: 'Edited product', brand: 'Preserved brand', custom_label_0: 'Meta Ads' });
      await reviewApply('reddit_delete_catalog_products', { product_ids: [product.id], acknowledge_permanent_deletion: true }, ['Delete catalog products permanently', 'Permanently deleted', 'feed']);expect(f.state.products.some(row => row.id === product.id)).toBe(false);expect(f.writes()).toHaveLength(3);
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(f.dir, { recursive: true, force: true }); }
  }, 20_000);
});
