import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine } from '@adport/core';
import { PinterestAdsClient, PinterestAdsProvider, pinterestTools, PINTEREST_TOKEN_URL } from '@adport/provider-pinterest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML } from '../src/ui.js';

// Wire fixtures follow Pinterest-owned OpenAPI 5.28.0, commit 2503147, inspected 2026-11-05.
describe('Pinterest catalog feed MCP and native widget contract', () => {
  it('returns SDK-valid private-source records, preserves paging arguments, and renders a name-only approval', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'adport-catalog-widget-')), account = '549000000001', catalogId = '549000000002', feedId = '549000000003', nextId = '549000000004';
    const date = '2026-11-05T00:00:00Z', source = 'https://feeds.example.test/private.csv?token=private-source';
    const feed = { id: feedId, catalog_type: 'RETAIL', name: 'QA <literal> feed', status: 'INACTIVE', format: 'CSV', default_locale: 'en-US', default_country: 'US', location: source, credentials: { username: 'feed-user', password: 'feed-password' }, created_at: date, updated_at: date };
    const calls: string[] = [];
    const provider = new PinterestAdsProvider(new PinterestAdsClient({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' }, async (url, init) => {
      const target = new URL(String(url)); calls.push(`${init?.method} ${target.pathname}`);
      if (target.href === PINTEREST_TOKEN_URL) return Response.json({ access_token: 'access', expires_in: 3600 });
      if (init?.method !== 'GET') throw new Error('Widget preview must not write');
      if (target.pathname === `/v5/ad_accounts/${account}`) return Response.json({ id: account, owner: { username: 'qa-owner' } });
      if (target.pathname === '/v5/catalogs') return Response.json({ items: [{ id: catalogId, name: 'QA', catalog_type: 'RETAIL', created_at: date, updated_at: date }] });
      if (target.pathname === '/v5/catalogs/feeds') return Response.json(target.searchParams.get('bookmark') ? { items: [{ ...feed, id: nextId, name: 'Second feed' }] } : { items: [feed], ...(target.searchParams.get('page_size') === '1' ? { bookmark: 'native-next' } : {}) });
      if (target.pathname === `/v5/catalogs/feeds/${feedId}`) return Response.json(feed);
      throw new Error('Unexpected resource');
    }));
    const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(path.join(dir, 'pending')), new AuditLog(path.join(dir, 'audit'))), providerModules: [{ provider, tools: pinterestTools(provider) }] });
    const server = createMcpServer({ runtime, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'catalog-widget-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await host.connect(ct);
    const doms: JSDOM[] = [];
    try {
      const tools = (await host.listTools()).tools;
      expect(tools.find(t => t.name === 'pinterest_get_feed')?.outputSchema).toMatchObject({ type: 'object', properties: { records: { type: 'array' } } });
      const args = { account_id: account, catalog_id: catalogId, page_size: 1 };
      const list = await host.callTool({ name: 'pinterest_feeds', arguments: args });
      expect(list.isError).not.toBe(true); expect(list.structuredContent).toMatchObject({ next_cursor: 'native-next', _adport: { view: 'records', next: { arguments: { ...args, bookmark: 'native-next' } } } });
      const callTool = vi.fn(async (name: string, input: Record<string, unknown>) => host.callTool({ name, arguments: input }));
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } }); doms.push(dom);
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));
        return dom;
      };
      const dom = mount(list), main = dom.window.document.querySelector('main')!;
      expect(main.textContent).toContain('QA <literal> feed'); expect(main.querySelectorAll('article')).toHaveLength(1);
      const more = main.querySelector<HTMLButtonElement>('[data-record-more]'); expect(more).not.toBeNull(); more!.click();
      await vi.waitFor(() => expect(main.textContent).toContain('Second feed'));
      expect(callTool).toHaveBeenCalledWith('pinterest_feeds', { ...args, bookmark: 'native-next' }); expect(main.querySelectorAll('article')).toHaveLength(2);
      const current = await provider.catalogs.getFeed(account, catalogId, feedId);
      const preview = await host.callTool({ name: 'pinterest_update_feed', arguments: { account_id: account, catalog_id: catalogId, feed_id: feedId, expected_snapshot_hash: current.feed.snapshot_hash, changes: { name: 'Renamed feed' } } });
      expect(preview.isError).not.toBe(true); expect(preview.structuredContent).toMatchObject({ applied: false, preview: { review: { fields: [{ label: 'Name', before: feed.name, after: 'Renamed feed' }] } } });
      const review = mount(preview).window.document.querySelector('main')!; expect(review.querySelector('.review-before')?.textContent).toBe(feed.name); expect(review.querySelector('.review-after')?.textContent).toBe('Renamed feed'); expect(review.querySelector('[data-approve]')?.textContent).toBe('Hold to apply');
      const create = await host.callTool({ name: 'pinterest_create_feed', arguments: { account_id: account, expected_context_hash: current.context_hash, confirm_source_access: true, feed: { catalog_id: catalogId, catalog_type: 'RETAIL', name: 'New feed', format: 'CSV', default_locale: 'en-US', default_country: 'US', location: source, credentials: { username: 'feed-user', password: 'feed-password' } } } });
      expect(create.isError).not.toBe(true); expect(((create.structuredContent as Record<string, unknown>)._adport as Record<string, unknown>).approval).toBeUndefined();
      const privateUpdate = await host.callTool({ name: 'pinterest_update_feed', arguments: { account_id: account, catalog_id: catalogId, feed_id: feedId, expected_snapshot_hash: current.feed.snapshot_hash, confirm_source_access: true, changes: { credentials: { username: 'feed-user', password: 'feed-password' } } } });
      expect(privateUpdate.isError).not.toBe(true); expect(((privateUpdate.structuredContent as Record<string, unknown>)._adport as Record<string, unknown>).approval).toBeUndefined();
      for (const value of [list, preview, create, privateUpdate, main.textContent, review.textContent]) for (const secret of [source, 'private-source', 'feed-user', 'feed-password']) expect(JSON.stringify(value)).not.toContain(secret);
      expect(calls.filter(c => !c.includes('/oauth/token')).every(c => c.startsWith('GET '))).toBe(true);
    } finally { for (const dom of doms) dom.window.close(); await host.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
