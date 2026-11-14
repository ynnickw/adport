import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { FileTikTokCatalogAccessStore, catalogGrant, TikTokClient, TikTokAdsProvider, tiktokTools } from '@adport/provider-tiktok';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

describe('TikTok project-scoped catalog SDK/widget flow', () => {
  it('reads authorized catalog data, reviews/applies exact rename and keeps permission administration out of hosted MCP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tiktok-catalog-widget-')), project = 'b310e750-d001-4427-8184-09bd05920e01', account = '7111000000000000001', bc = '111', catalogId = '222', calls: Array<{ url: URL; method: string; body?: unknown }> = [];
    const scope = { accountId: account, businessId: bc, resourceId: catalogId, kind: 'catalog' as const }, store = new FileTikTokCatalogAccessStore(join(dir, 'grants'));await store.compareAndSet(scope, catalogGrant(scope).hash, 'write');
    let catalog = { catalog_id: catalogId, catalog_name: 'QA <catalog>', catalog_type: 'ECOM', bc_info: { bc_id: bc, bc_name: 'QA Business Center' }, catalog_conf: { country: 'DE', currency: 'EUR' }, ad_creation_eligible: 'AVAILABLE' };
    const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert' }, async (input, init = {}) => {
      const url = new URL(String(input)), body = init.body ? JSON.parse(String(init.body)) : undefined;calls.push({ url, method: String(init.method), body });
      if (url.pathname === '/open_api/v1.3/catalog/get/' && init.method === 'GET') return Response.json({ code: 0, data: { list: [catalog], page_info: { page: 1, total_page: 1 } } });
      if (url.pathname === '/open_api/v1.3/catalog/update/' && init.method === 'POST') { catalog = { ...catalog, catalog_name: body.name };return Response.json({ code: 0, data: { catalog_id: catalogId } }); }
      throw new Error('Unexpected fixture endpoint');
    }), { appId: 'inert', secret: 'inert' }, undefined, store);
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: tiktokTools(provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['tiktok'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'tiktok-catalog-widget-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const tools = (await host.listTools()).tools;expect(tools.some(value => value.name === 'tiktok_set_catalog_access')).toBe(false);expect(tools.some(value => value.name === 'tiktok_catalog_access_snapshot')).toBe(false);expect(tools.find(value => value.name === 'tiktok_get_catalog')?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      const args = { project_id: project, account_id: account, bc_id: bc, catalog_id: catalogId }, result = await host.callTool({ name: 'tiktok_get_catalog', arguments: args });expect(result.isError).not.toBe(true);
      const mount = (data: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test/' });doms.push(dom);Object.defineProperty(dom.window, 'openai', { value: { notifyIntrinsicHeight() {} } });dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: data } }));return dom.window.document.querySelector('main')!;
      };
      const records = mount(result);expect(records.querySelector('article')?.textContent).toContain('QA <catalog>');expect(records.querySelector('article')?.textContent).toContain('AVAILABLE');expect(records.querySelector('catalog')).toBeNull();
      const hash = (result.structuredContent as { catalog: { configuration_hash: string } }).catalog.configuration_hash, changes = { ...args, name: 'QA renamed', expected_configuration_hash: hash, acknowledge_shared_effects: true }, preview = await host.callTool({ name: 'tiktok_update_catalog', arguments: changes });expect(preview.isError).not.toBe(true);const review = mount(preview);expect(review.querySelector('.review-before')?.textContent).toBe('QA <catalog>');expect(review.querySelector('.review-after')?.textContent).toBe('QA renamed');expect(review.querySelector('[data-approve]')?.textContent).toBe('Hold to apply');expect(calls.every(call => call.method === 'GET')).toBe(true);
      const data = preview.structuredContent as { pending_operation_id: string; _adport: { approval: { arguments: Record<string, unknown> } } };expect(data._adport.approval.arguments).toMatchObject(changes);
      const applied = await host.callTool({ name: 'tiktok_update_catalog', arguments: { ...changes, pending_operation_id: data.pending_operation_id } });expect(applied.isError).not.toBe(true);expect(applied.structuredContent).toHaveProperty('result.applied', true);expect(calls.filter(call => call.method === 'POST')).toEqual([expect.objectContaining({ body: { bc_id: bc, catalog_id: catalogId, name: 'QA renamed' } })]);expect(calls.at(-1)?.method).toBe('GET');
      const unauthorized = await host.callTool({ name: 'tiktok_get_catalog', arguments: { ...args, catalog_id: '999' } });expect(unauthorized.isError).toBe(true);expect(calls.some(call => call.url.searchParams.get('catalog_id') === '999')).toBe(false);
    } finally { for (const dom of doms) dom.window.close();await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  });
});
