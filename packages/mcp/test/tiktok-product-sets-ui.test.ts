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

describe('TikTok product-set SDK and widget flow', () => {
  it('retains scoped paging/card nodes and reviews the set lifecycle through the shared approval gate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tiktok-product-set-widget-'));
    const project = 'b310e750-d001-4427-8184-09bd05920e01', account = '7111000000000000001', bc = '111', catalog = '222';
    const store = new FileTikTokCatalogAccessStore(join(dir, 'grants'));
    const scope = { accountId: account, businessId: bc, resourceId: catalog, kind: 'catalog' as const };
    await store.compareAndSet(scope, catalogGrant(scope).hash, 'write');
    const sets = [{ product_set_id: '333', catalog_id: catalog, product_set_name: 'QA <set>', conditions: { or: [{ field: 'price', operation: 'LT', value: '250' }] } }, { product_set_id: '444', catalog_id: catalog, product_set_name: 'Second QA set', conditions: {} }];
    const calls: Array<{ url: URL; method: string; body?: Record<string, unknown> }> = [];
    const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert' }, async (raw, init = {}) => {
      const url = new URL(String(raw)), body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: String(init.method), body });
      if (url.pathname.endsWith('/catalog/get/')) return Response.json({ code: 0, data: { list: [{ catalog_id: catalog, catalog_name: 'QA', catalog_type: 'ECOM', bc_info: { bc_id: bc }, catalog_conf: {} }] } });
      if (url.pathname.endsWith('/catalog/set/get/')) return Response.json({ code: 0, data: { list: sets.filter(row => !url.searchParams.has('product_set_id') || row.product_set_id === url.searchParams.get('product_set_id')) } });
      if (url.pathname.endsWith('/catalog/set/create/')) { sets.push({ product_set_id: '555', catalog_id: catalog, product_set_name: body.product_set_name, conditions: body.conditions });return Response.json({ code: 0, data: { product_set_id: '555' } }); }
      if (url.pathname.endsWith('/catalog/set/update/')) { const target = sets.find(row => row.product_set_id === body.product_set_id)!;if (body.product_set_name !== undefined) target.product_set_name = body.product_set_name;if (body.conditions !== undefined) target.conditions = body.conditions;return Response.json({ code: 0, data: { product_set_id: body.product_set_id } }); }
      if (url.pathname.endsWith('/catalog/set/delete/')) { for (let n = sets.length - 1; n >= 0; n--) if (body.product_set_ids.includes(sets[n]!.product_set_id)) sets.splice(n, 1);return Response.json({ code: 0, data: { product_set_ids: body.product_set_ids } }); }
      if (url.pathname.endsWith('/catalog/set/product/get/')) {
        const page = Number(url.searchParams.get('page'));
        return Response.json({ code: 0, data: { catalog_id: catalog, product_set_id: '333', product_count: 2, products: [{ product_id: page === 1 ? '9007199254740993' : '9007199254740994', product_name: page === 1 ? 'QA <product>' : 'Second product' }], page_info: { page, page_size: 1, total_number: 2, total_page: 2 } } });
      }
      throw new Error('Unexpected fixture endpoint');
    }), { appId: 'inert', secret: 'inert' }, undefined, store);
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: tiktokTools(provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['tiktok'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] });
    const host = new Client({ name: 'tiktok-product-set-widget-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const tools = (await host.listTools()).tools;
      for (const name of ['tiktok_product_sets', 'tiktok_product_set_products']) expect(tools.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      expect(tools.find(tool => tool.name === 'tiktok_rename_product_set')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(tools.find(tool => tool.name === 'tiktok_create_product_set')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      for (const name of ['tiktok_update_product_set_conditions', 'tiktok_delete_product_sets']) expect(tools.find(tool => tool.name === name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => host.callTool({ name, arguments: args }));
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test/', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));
        return dom.window.document.querySelector('main')!;
      };
      const args = { project_id: project, account_id: account, bc_id: bc, catalog_id: catalog, page_size: 1 };
      const initial = await host.callTool({ name: 'tiktok_product_sets', arguments: args });expect(initial.isError).not.toBe(true);
      const main = mount(initial), root = main.querySelector<HTMLElement>('[data-record-list]')!, first = root.firstElementChild;root.scrollTop = 28;
      expect(main.textContent).toContain('QA <set>');expect(main.querySelector('set')).toBeNull();
      main.querySelector<HTMLButtonElement>('[data-record-more]')!.click();await vi.waitFor(() => expect(main.textContent).toContain('Second QA set'));
      expect(root.firstElementChild).toBe(first);expect(root.scrollTop).toBe(28);expect(main.querySelectorAll('article')).toHaveLength(2);
      expect(callTool).toHaveBeenCalledWith('tiktok_product_sets', expect.objectContaining({ ...args, cursor: expect.any(String) }));
      const products = await host.callTool({ name: 'tiktok_product_set_products', arguments: { ...args, product_set_id: '333' } });expect(products.isError).not.toBe(true);
      const productMain = mount(products);expect(productMain.textContent).toContain('QA <product>');expect(productMain.querySelector('product')).toBeNull();
      productMain.querySelector<HTMLButtonElement>('[data-record-more]')!.click();await vi.waitFor(() => expect(productMain.textContent).toContain('Second product'));
      expect(callTool).toHaveBeenCalledWith('tiktok_product_set_products', expect.objectContaining({ ...args, product_set_id: '333', page: 2 }));
      const data = initial.structuredContent as { sets: Array<{ configuration_hash: string }> };
      const rename = { project_id: project, account_id: account, bc_id: bc, catalog_id: catalog, product_set_id: '333', product_set_name: 'Renamed QA set', expected_configuration_hash: data.sets[0]!.configuration_hash, acknowledge_shared_effects: true };
      const preview = await host.callTool({ name: 'tiktok_rename_product_set', arguments: rename });expect(preview.isError).not.toBe(true);const review = mount(preview);
      expect(review.querySelector('.review-before')?.textContent).toBe('QA <set>');expect(review.querySelector('.review-after')?.textContent).toBe('Renamed QA set');expect(calls.every(call => call.method === 'GET')).toBe(true);
      const pending = preview.structuredContent as { pending_operation_id: string; _adport: { approval: { arguments: Record<string, unknown> } } };expect(pending._adport.approval.arguments).toMatchObject(rename);
      const applied = await host.callTool({ name: 'tiktok_rename_product_set', arguments: { ...rename, pending_operation_id: pending.pending_operation_id } });expect(applied.isError).not.toBe(true);expect(applied.structuredContent).toHaveProperty('result.applied', true);
      expect(calls.filter(call => call.method === 'POST')).toEqual([expect.objectContaining({ body: { bc_id: bc, catalog_id: catalog, product_set_id: '333', product_set_name: 'Renamed QA set' } })]);expect(sets[0]!.conditions).toEqual({ or: [{ field: 'price', operation: 'LT', value: '250' }] });expect(calls.at(-1)!.method).toBe('GET');
      const selected = { project_id: project, account_id: account, bc_id: bc, catalog_id: catalog };
      const parent = await host.callTool({ name: 'tiktok_get_catalog', arguments: selected });expect(parent.isError).not.toBe(true);
      const parentHash = (parent.structuredContent as { catalog: { configuration_hash: string } }).catalog.configuration_hash;
      const conditions = { and: [{ field: 'brand', operation: 'I_CONTAIN', value: ['QA <tag>', '<script>globalThis.executed=true</script>'] }] };
      const create = { ...selected, product_set_name: 'Created <QA set>', conditions, expected_catalog_hash: parentHash, acknowledge_shared_effects: true };
      const createPreview = await host.callTool({ name: 'tiktok_create_product_set', arguments: create });expect(createPreview.isError).not.toBe(true);
      const creationReview = mount(createPreview);expect(creationReview.textContent).toContain('All conditions');expect(creationReview.textContent).toContain('brand matches any value');expect(creationReview.querySelector('script,tag')).toBeNull();expect(Reflect.get(creationReview.ownerDocument.defaultView!, 'executed')).toBeUndefined();expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
      const approval = createPreview.structuredContent as { pending_operation_id: string; _adport: { approval: { arguments: Record<string, unknown> } } };expect(approval._adport.approval.arguments).toMatchObject(create);
      expect((await host.callTool({ name: 'tiktok_create_product_set', arguments: { ...create, pending_operation_id: approval.pending_operation_id } })).structuredContent).toHaveProperty('result.resourceIds', ['555']);
      const readSet = async () => {
        const result = await host.callTool({ name: 'tiktok_product_sets', arguments: { ...selected, product_set_id: '555' } });expect(result.isError).not.toBe(true);
        return (result.structuredContent as { sets: Array<{ configuration_hash: string }> }).sets[0]!.configuration_hash;
      };
      const filters = { ...selected, product_set_id: '555', conditions: { or: [{ field: 'title', operation: 'PREFIX', value: 'QA' }] }, expected_configuration_hash: await readSet(), acknowledge_shared_effects: true };
      const filterPreview = await host.callTool({ name: 'tiktok_update_product_set_conditions', arguments: filters });expect(filterPreview.isError).not.toBe(true);
      const filterReview = mount(filterPreview);expect(filterReview.textContent).toContain('Existing ads using this shared set');expect(filterReview.querySelector('.review-before')?.textContent).toContain('brand matches any value');expect(filterReview.querySelector('.review-after')?.textContent).toContain('title starts with');
      const filterPending = filterPreview.structuredContent as { pending_operation_id: string; _adport: { approval: { arguments: Record<string, unknown> } } };expect(filterPending._adport.approval.arguments).toMatchObject(filters);
      expect((await host.callTool({ name: 'tiktok_update_product_set_conditions', arguments: { ...filters, pending_operation_id: filterPending.pending_operation_id } })).structuredContent).toHaveProperty('result.applied', true);
      expect(sets.find(row => row.product_set_id === '555')!.product_set_name).toBe('Created <QA set>');
      const remove = { ...selected, sets: [{ product_set_id: '555', expected_configuration_hash: await readSet() }], acknowledge_shared_effects: true };
      const deletePreview = await host.callTool({ name: 'tiktok_delete_product_sets', arguments: remove });expect(deletePreview.isError).not.toBe(true);
      const deletionReview = mount(deletePreview);expect(deletionReview.textContent).toContain('Permanently');expect(deletionReview.textContent).toContain('Created <QA set>');expect(deletionReview.querySelector('[data-approve]')).not.toBeNull();
      const deletePending = deletePreview.structuredContent as { pending_operation_id: string; _adport: { approval: { arguments: Record<string, unknown> } } };expect(deletePending._adport.approval.arguments).toMatchObject(remove);
      const approvedDelete = { ...remove, pending_operation_id: deletePending.pending_operation_id };
      expect((await host.callTool({ name: 'tiktok_delete_product_sets', arguments: approvedDelete })).structuredContent).toHaveProperty('result.resourceIds', ['555']);
      expect((await host.callTool({ name: 'tiktok_delete_product_sets', arguments: approvedDelete })).isError).toBe(true);
      expect(calls.filter(call => call.method === 'POST')).toHaveLength(4);expect(calls.filter(call => call.method === 'POST').slice(1).map(call => call.body)).toEqual([
        { bc_id: bc, catalog_id: catalog, product_set_name: 'Created <QA set>', conditions },
        { bc_id: bc, catalog_id: catalog, product_set_id: '555', conditions: filters.conditions },
        { bc_id: bc, catalog_id: catalog, product_set_ids: ['555'] },
      ]);expect(sets.map(row => row.product_set_id)).toEqual(['333', '444']);
    } finally { for (const dom of doms) dom.window.close();await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  });
});
