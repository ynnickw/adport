import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { pinterestTools } from '../../pinterest/src/tools.js';
import { productGroupFixture, PG_ACCOUNT, PG_CATALOG, PG_ID, PG_CREATED } from '../../pinterest/test/product-group-fixture.js';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Real MCP SDK/shared policy transport with synthetic native data and host
// bridges. Actual claude.ai/chatgpt.com checks are a separate requirement.
describe('Pinterest product group SDK/widgets', () => {
  it.each(['openai', 'mcp'] as const)('keeps paged cards/scroll and applies exact reviewed group changes via %s', async bridge => {
    const f = productGroupFixture(), dir = await mkdtemp(join(tmpdir(), 'pinterest-group-widget-')), project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0', scope = { project_id: project, account_id: PG_ACCOUNT, catalog_id: PG_CATALOG };
    f.state.groups.push({ ...f.state.groups[0], id: '549000000006', name: 'Second group' });f.state.products.push({ ...f.state.products[0], metadata: { ...f.state.products[0]!.metadata, item_id: 'second-sku' }, pin: { title: 'Second product' } });
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: pinterestTools(f.provider) }] }), runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['pinterest'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'pinterest-group-widget-qa', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [], applied = new Map<string, any>();
    const call = async (name: string, args: Record<string, unknown>) => { const result = await host.callTool({ name, arguments: args });expect(result.isError).not.toBe(true);return result; }, callTool = vi.fn(async (name: string, args: Record<string, unknown>) => { const result = await call(name, args);applied.set(name, result);return result; });
    const mount = (result: unknown) => {
      const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
      if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
    };
    try {
      const names = ['pinterest_product_groups', 'pinterest_get_product_group', 'pinterest_product_group_counts', 'pinterest_product_group_products', 'pinterest_product_group_context', 'pinterest_create_product_group', 'pinterest_update_product_group', 'pinterest_delete_product_group'], tools = (await host.listTools()).tools;
      for (const name of names) { expect(tools.filter(tool => tool.name === name)).toHaveLength(1);expect(tools.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI); }
      const more = async (name: string, payload: Record<string, unknown>, next: string) => {
        const view = mount(await call(name, { ...scope, ...payload, page_size: 1 })), list = view.querySelector<HTMLElement>('[data-record-list]')!, card = list.firstElementChild, count = callTool.mock.calls.length;list.scrollTop = 50;view.querySelector<HTMLButtonElement>('[data-record-more]')!.click();view.querySelector<HTMLButtonElement>('[data-record-more]')!.click();await vi.waitFor(() => expect(view.textContent).toContain(next));expect(list.firstElementChild).toBe(card);expect(list.scrollTop).toBe(50);expect(callTool).toHaveBeenCalledTimes(count + 1);expect(callTool).toHaveBeenLastCalledWith(name, expect.objectContaining({ ...scope, ...payload, page_size: 1, bookmark: expect.any(String) }));
      };
      await more('pinterest_product_groups', {}, 'Second group');await more('pinterest_product_group_products', { product_group_id: PG_ID }, 'Second product');
      const schema = (await call('pinterest_product_group_filter_schema', { project_id: project, catalog_type: 'CREATIVE_ASSETS' })).structuredContent as any;expect(schema.fields).toHaveProperty('CREATIVE_ASSETS_ID');expect(schema.schema).toBeDefined();
      expect(mount(await call('pinterest_product_group_counts', { ...scope, product_group_id: PG_ID })).textContent).toContain('Synthetic group');
      const reviewApply = async (name: string, payload: Record<string, unknown>, labels: string[]) => {
        const args = { ...scope, ...payload }, count = f.writes().length, preview = await call(name, args);expect(f.writes()).toHaveLength(count);expect(JSON.stringify(preview)).not.toContain('PRIVATE');const view = mount(preview);for (const label of labels) expect(view.textContent).toContain(label);
        view.querySelector<HTMLButtonElement>('[data-approve]')!.dispatchEvent(new view.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(view.querySelector('.operation-status')?.textContent).toBe('Applied with warnings'), { timeout: 3000 });expect(callTool).toHaveBeenLastCalledWith(name, expect.objectContaining({ ...args, pending_operation_id: expect.any(String) }));expect(f.writes()).toHaveLength(count + 1);expect(Reflect.get(view.ownerDocument.defaultView!, 'executed')).toBeUndefined();return applied.get(name).structuredContent as any;
      };
      const definition = { ...f.definition(), name: 'QA <script>globalThis.executed=true</script>' }, context = (await call('pinterest_product_group_context', { ...scope, action: { kind: 'create', definition } })).structuredContent as any;expect(mount({ structuredContent: context }).textContent).toContain('Synthetic catalog');
      const create = await reviewApply('pinterest_create_product_group', { definition, expected_context_hash: context.context_hash }, ['Create product group', 'Product selection', 'Catalog']);expect(create.result.details).toMatchObject({ configuration_readback: 'VERIFIED', matched_inventory_verified: false });
      await reviewApply('pinterest_update_product_group', await f.update({ name: 'Edited group' }, PG_CREATED), ['Update product group', 'Edited group']);const remove = await reviewApply('pinterest_delete_product_group', await f.remove(PG_CREATED), ['Delete product group permanently', 'Edited group']);expect(remove.result.details).toMatchObject({ deletion_readback: 'ABSENT_FROM_COMPLETE_FILTERED_LIST', items_deleted: false });expect(f.writes()).toHaveLength(3);expect(f.state.products).toHaveLength(2);
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  }, 20_000);
});
