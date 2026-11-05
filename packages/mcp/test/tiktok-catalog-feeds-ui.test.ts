import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { FileTikTokCatalogAccessStore, catalogGrant, TikTokClient, TikTokAdsProvider, tiktokTools } from '@adport/provider-tiktok';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML } from '../src/ui.js';

describe('TikTok catalog feeds SDK/widget contract', () => {
  it('retains scoped paging, hides private source arguments and reviews exact guarded schedule/deletion changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tiktok-feed-widget-')), account = '7678335757387513873', bc = '111', catalog = '222', project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0';
    const store = new FileTikTokCatalogAccessStore(join(dir, 'grants')), scope = { accountId: account, businessId: bc, resourceId: catalog, kind: 'catalog' as const };
    await store.compareAndSet(scope, catalogGrant(scope).hash, 'write');
    const source = 'https://feeds.example.test/private/products.csv?secret=PRIVATE';
    const rows = [{ feed_id: '333', feed_name: 'QA <feed>', feed_type: 'DATA_FEED', status: 'OFF', last_update_param: { uri: source, update_mode: 'INCREMENTAL', timezone: 'Europe/Berlin', interval_type: 'DAILY', interval_count: 1, hour: 0, minute: 0, day_of_month: null } }, { feed_id: '444', feed_name: 'Second feed', feed_type: 'DATA_FEED', status: 'OFF', last_update_param: { uri: source, update_mode: 'INCREMENTAL', timezone: 'Europe/Berlin', interval_type: 'DAILY', interval_count: 1, hour: 0, minute: 0, day_of_month: null } }];
    const calls: Array<{ url: URL; method: string; body?: Record<string, unknown> }> = [];
    const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert' }, async (raw, init = {}) => {
      const url = new URL(String(raw)), body = init.body ? JSON.parse(String(init.body)) : undefined;calls.push({ url, method: String(init.method), body });
      if (url.pathname.endsWith('/catalog/get/')) return Response.json({ code: 0, data: { list: [{ catalog_id: catalog, catalog_name: 'QA', catalog_type: 'ECOM', bc_info: { bc_id: bc }, catalog_conf: { is_multi_country: true } }] } });
      if (url.pathname.endsWith('/catalog/feed/get/')) return Response.json({ code: 0, data: { feed_list: rows.filter(row => !url.searchParams.has('feed_id') || row.feed_id === url.searchParams.get('feed_id')) } });
      if (url.pathname.endsWith('/catalog/feed/create/')) { const s = body.schedule_param;rows.push({ feed_id: '555', feed_name: body.feed_name, feed_type: 'DATA_FEED', status: s ? 'ON' : 'OFF', last_update_param: { uri: s?.source.uri ?? null, update_mode: body.update_mode, timezone: s?.timezone ?? null, interval_type: s?.interval_type ?? null, interval_count: s?.interval_count ?? null, hour: s?.hour ?? null, minute: s?.minute ?? null, day_of_month: null } });return Response.json({ code: 0, data: { feed_id: '555' } }); }
      if (url.pathname.endsWith('/catalog/feed/switch/')) { rows.find(row => row.feed_id === body.feed_id)!.status = body.status;return Response.json({ code: 0, data: {} }); }
      if (url.pathname.endsWith('/catalog/feed/delete/')) { rows.splice(rows.findIndex(row => row.feed_id === body.feed_id), 1);return Response.json({ code: 0, data: { feed_id: body.feed_id } }); }
      throw new Error('Unexpected fixture endpoint');
    }), { appId: 'inert', secret: 'inert' }, undefined, store);
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: tiktokTools(provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['tiktok'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'tiktok-feed-widget', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => host.callTool({ name, arguments: args }));
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test/', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
      };
      const selected = { project_id: project, account_id: account, bc_id: bc, catalog_id: catalog }, args = { ...selected, page_size: 1 };
      const initial = await host.callTool({ name: 'tiktok_catalog_feeds', arguments: args });expect(initial.isError).not.toBe(true);expect(JSON.stringify(initial)).not.toContain(source);
      const main = mount(initial), list = main.querySelector<HTMLElement>('[data-record-list]')!, first = list.firstElementChild;list.scrollTop = 31;expect(main.textContent).toContain('QA <feed>');expect(main.querySelector('feed')).toBeNull();
      main.querySelector<HTMLButtonElement>('[data-record-more]')!.click();await vi.waitFor(() => expect(main.textContent).toContain('Second feed'));expect(list.firstElementChild).toBe(first);expect(list.scrollTop).toBe(31);expect(callTool).toHaveBeenCalledWith('tiktok_catalog_feeds', expect.objectContaining({ ...args, cursor: expect.any(String) }));
      const hash = (initial.structuredContent as { feeds: Array<{ configuration_hash: string }> }).feeds[0]!.configuration_hash;
      const change = { ...selected, feed_id: '333', status: 'ON', expected_configuration_hash: hash, acknowledge_shared_effects: true, acknowledge_automatic_processing: true };
      const preview = await host.callTool({ name: 'tiktok_set_catalog_feed_schedule_status', arguments: change });expect(preview.isError).not.toBe(true);const review = mount(preview);expect(review.textContent).toContain('ON resumes automatic product processing');expect(review.querySelector('.review-before')?.textContent).toBe('OFF');expect([...review.querySelectorAll('.review-after')].map(node => node.textContent)).toContain('ON');
      const pending = preview.structuredContent as { pending_operation_id: string; _adport: { approval: { arguments: Record<string, unknown> } } };expect(pending._adport.approval.arguments).toMatchObject(change);expect(calls.every(call => call.method === 'GET')).toBe(true);
      expect((await host.callTool({ name: 'tiktok_set_catalog_feed_schedule_status', arguments: { ...change, pending_operation_id: pending.pending_operation_id } })).structuredContent).toHaveProperty('result.applied', true);
      const parent = await host.callTool({ name: 'tiktok_get_catalog', arguments: selected }), parentHash = (parent.structuredContent as { catalog: { configuration_hash: string } }).catalog.configuration_hash;
      const create = { ...selected, feed_name: 'Private QA source', update_mode: 'INCREMENTAL', expected_catalog_hash: parentHash, acknowledge_shared_effects: true, acknowledge_automatic_processing: true, schedule_param: { source: { uri: source, username: 'source-user', password: 'source-password' }, interval_type: 'DAILY', interval_count: 1, timezone: 'Europe/Berlin', hour: 0, minute: 0 } };
      const privatePreview = await host.callTool({ name: 'tiktok_create_catalog_feed', arguments: create });expect(privatePreview.isError).not.toBe(true);
      for (const secret of [source, 'source-user', 'source-password']) expect(JSON.stringify(privatePreview)).not.toContain(secret);
      const privateData = privatePreview.structuredContent as { pending_operation_id: string; _adport: { approval?: unknown } };expect(privateData._adport.approval).toBeUndefined();const privateReview = mount(privatePreview);expect(privateReview.textContent).toContain('Supplied; values hidden');expect(privateReview.querySelector('[data-approve]')).toBeNull();
      expect((await host.callTool({ name: 'tiktok_create_catalog_feed', arguments: { ...create, pending_operation_id: privateData.pending_operation_id } })).structuredContent).toHaveProperty('result.resourceIds', ['555']);
      const read = await host.callTool({ name: 'tiktok_catalog_feeds', arguments: { ...selected, feed_id: '555' } }), snapshot = (read.structuredContent as { feeds: Array<{ configuration_hash: string }> }).feeds[0]!.configuration_hash;
      const remove = { ...selected, feed_id: '555', expected_configuration_hash: snapshot, acknowledge_shared_effects: true }, deletePreview = await host.callTool({ name: 'tiktok_delete_catalog_feed', arguments: remove });expect(deletePreview.isError).not.toBe(true);expect(mount(deletePreview).textContent).toContain('Permanently');
      const deleteData = deletePreview.structuredContent as { pending_operation_id: string; _adport: { approval: { arguments: Record<string, unknown> } } };expect(deleteData._adport.approval.arguments).toMatchObject(remove);
      expect((await host.callTool({ name: 'tiktok_delete_catalog_feed', arguments: { ...remove, pending_operation_id: deleteData.pending_operation_id } })).structuredContent).toHaveProperty('result.applied', true);
      expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([{ bc_id: bc, catalog_id: catalog, feed_id: '333', status: 'ON' }, { bc_id: bc, catalog_id: catalog, feed_name: create.feed_name, update_mode: 'INCREMENTAL', schedule_param: create.schedule_param }, { bc_id: bc, catalog_id: catalog, feed_id: '555' }]);expect(calls.at(-1)!.method).toBe('GET');
    } finally { for (const dom of doms) dom.window.close();await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  });
});
