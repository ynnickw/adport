import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { FileRedditCatalogAccessStore, catalogGrant, creationScope, RedditAdsClient, RedditAdsProvider, redditTools } from '@adport/provider-reddit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Shared definitions and real SDK transport with synthetic bridges; not live host/provider verification.
describe('Reddit catalog SDK/widgets', () => {
  it.each(['openai', 'mcp'] as const)('reviews creation, rename, source replacement/clear and deletion through %s', async bridge => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-reddit-catalog-ui-')), account = 'a2_qa', business = '1e200a0b-4e98-32cc-dd47-3006e4c85bb2', catalogId = 'catalog_new', pixel = 'pixel_qa', project = 'b310e750-d001-4427-8184-09bd05920e01', scope = { account_id: account, business_id: business, project_id: project }, name = 'QA <script>globalThis.executed=true</script>';
    const store = new FileRedditCatalogAccessStore(join(dir, 'grants')), delegation = creationScope(account, business);await store.compareAndSet(delegation, catalogGrant(delegation).hash, 'create');let catalog: Record<string, unknown> | undefined;const mutations: Array<{ method: string; path: string; body?: unknown }> = [];
    const provider = new RedditAdsProvider(new RedditAdsClient({ clientId: 'inert', clientSecret: 'inert', refreshToken: 'inert', userAgent: 'desktop:adport:qa (by /u/qa)' }, async (raw, init = {}) => {
      const url = new URL(String(raw)), ok = (data: unknown, status = 200) => Response.json({ data }, { status });
      if (url.pathname === '/api/v1/access_token') return Response.json({ access_token: 'inert', expires_in: 3600 });
      if (init.method === 'GET') {
        if (url.pathname === '/api/v3/businesses/' + business) return ok({ id: business, name: 'QA Business', phone: 'PRIVATE-BUSINESS' });
        if (url.pathname === '/api/v3/ad_accounts/' + account + '/pixels') return ok([{ id: pixel, ad_account_id: account, script: 'PRIVATE-SCRIPT' }]);
        if (url.pathname === '/api/v3/product_catalogs/' + catalogId) return catalog ? ok(catalog) : Response.json({ message: 'PRIVATE-NOT-FOUND' }, { status: 404 });
      }
      const body = init.body ? JSON.parse(String(init.body)) : undefined;mutations.push({ method: init.method!, path: url.pathname, body });
      if (init.method === 'POST' && url.pathname === '/api/v3/businesses/' + business + '/product_catalogs') { expect(body).toEqual({ data: { name, default_currency: 'EUR', default_language: 'de', event_sources: [] } });catalog = { id: catalogId, business_id: business, ...body.data, unknown_private: 'PRIVATE-CATALOG' };return ok(catalog, 201); }
      if (init.method === 'PATCH' && url.pathname === '/api/v3/product_catalogs/' + catalogId) { Object.assign(catalog!, body.data);return ok(catalog); }
      if (init.method === 'DELETE' && url.pathname === '/api/v3/product_catalogs/' + catalogId) { catalog = undefined;return new Response(null, { status: 204 }); }
      throw new Error('Unexpected catalog fixture endpoint');
    }), undefined, store), base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: redditTools(provider) }] }), runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['reddit'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'reddit-catalog-widget-qa', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => host.callTool({ name, arguments: args }));
      const reviewAndApply = async (tool: string, args: Record<string, unknown>, expected: string[]) => {
        const before = mutations.length, preview = await host.callTool({ name: tool, arguments: args });expect(preview.isError).not.toBe(true);expect(mutations).toHaveLength(before);expect(JSON.stringify(preview)).not.toContain('PRIVATE-');
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test/', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: preview } }));const main = dom.window.document.querySelector('main')!;for (const text of expected) expect(main.textContent).toContain(text);expect(Reflect.get(dom.window, 'executed')).toBeUndefined();
        const approve = main.querySelector<HTMLButtonElement>('[data-approve]');expect(approve).not.toBeNull();approve!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(main.querySelector('.operation-status')?.textContent).toBe('Applied'), { timeout: 3000 });expect(callTool).toHaveBeenLastCalledWith(tool, expect.objectContaining({ ...args, pending_operation_id: expect.any(String) }));expect(mutations).toHaveLength(before + 1);
      };
      const tools = (await host.listTools()).tools;for (const name of ['reddit_catalog_access', 'reddit_get_catalog', 'reddit_catalog_creation_context', 'reddit_catalog_event_source_context', 'reddit_create_catalog', 'reddit_rename_catalog', 'reddit_set_catalog_event_sources', 'reddit_delete_catalog']) expect(tools.find(t => t.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);for (const name of ['reddit_catalog_access_snapshot', 'reddit_set_catalog_access']) expect(tools.find(t => t.name === name)).toBeUndefined();
      const creation = await host.callTool({ name: 'reddit_catalog_creation_context', arguments: scope });expect(creation.isError).not.toBe(true);const hashes = creation.structuredContent as Record<string, unknown>;
      await reviewAndApply('reddit_create_catalog', { ...scope, name, default_currency: 'EUR', default_language: 'de', event_sources: [], expected_creation_access_hash: hashes.expected_creation_access_hash, expected_event_sources_hash: hashes.expected_event_sources_hash, acknowledge_new_catalog_management: true }, ['Create catalog', 'New catalog project access', 'Default currency', 'not atomic']);
      expect((await store.get({ accountId: account, businessId: business, resourceId: catalogId, kind: 'catalog' })).mode).toBe('write');
      const exact = { ...scope, catalog_id: catalogId }, read = async () => { const result = await host.callTool({ name: 'reddit_get_catalog', arguments: exact });expect(result.isError).not.toBe(true);expect(JSON.stringify(result)).not.toContain('PRIVATE-');return (result.structuredContent as any).catalog; };
      await reviewAndApply('reddit_rename_catalog', { ...exact, name: 'Renamed QA', expected_configuration_hash: (await read()).configuration_hash, acknowledge_shared_effects: true }, ['Rename catalog', 'Name', 'Unselected configuration']);
      for (const ids of [[pixel], []]) { const result = await host.callTool({ name: 'reddit_catalog_event_source_context', arguments: { ...exact, event_sources: ids } });expect(result.isError).not.toBe(true);expect(JSON.stringify(result)).not.toContain('PRIVATE-');const context = result.structuredContent as Record<string, unknown>;await reviewAndApply('reddit_set_catalog_event_sources', { ...exact, event_sources: ids, expected_configuration_hash: context.expected_configuration_hash, expected_event_sources_hash: context.expected_event_sources_hash, acknowledge_shared_effects: true, acknowledge_measurement_effects: true }, ['Replace catalog event sources', 'Event-source Pixels', 'No conversion events']); }
      const current = await read();await reviewAndApply('reddit_delete_catalog', { ...exact, expected_configuration_hash: current.configuration_hash, confirm_catalog_name: current.name, acknowledge_shared_effects: true, acknowledge_delete_contents: true }, ['Delete catalog permanently', 'Contents affected', 'not enumerated or frozen']);
      expect(mutations.map(m => m.method)).toEqual(['POST', 'PATCH', 'PATCH', 'PATCH', 'DELETE']);expect(mutations.slice(1, 4).map(m => m.body)).toEqual([{ data: { name: 'Renamed QA' } }, { data: { event_sources: [pixel] } }, { data: { event_sources: [] } }]);expect(catalog).toBeUndefined();
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  }, 20_000);
});
