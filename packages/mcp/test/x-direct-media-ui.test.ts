import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { XAdsClient, XAdsProvider, xTools } from '@adport/provider-x';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Synthetic native API + real MCP SDK/DOM bridges. Not actual Claude/ChatGPT QA.
describe.each(['mcp', 'openai'] as const)('X direct-media %s widget bridge', bridge => {
  it('preserves gallery playback/paging and requires separate held approval for association creation/removal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-x-direct-widget-')), account = 'a1', project = 'b310e750-d001-4427-8184-09bd05920e01';
    const assets = [1, 2, 3].map(index => ({ id: `am${index}`, creative_type: 'PREROLL', video_id: `13_77179171717546803${index}`, media_url: `https://video.twimg.com/source-${index}.mp4`, deleted: false }));
    const associations = [1, 2].map(index => ({ id: `mc${index}`, line_item_id: 'l1', account_media_id: `am${index}`, creative_type: 'PREROLL', entity_status: 'ACTIVE', deleted: false, landing_url: null }));
    const mutations: Array<{ method: string; path: string }> = [];
    const provider = new XAdsProvider(new XAdsClient({ consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' }, async (raw, init = {}) => {
      const url = new URL(String(raw)), path = url.pathname.replace(`/12/accounts/${account}`, ''), q = url.searchParams, ok = (data: unknown) => Response.json({ data });
      if (init.method === 'GET') {
        if (!path) return ok({ id: account, name: 'QA', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false });
        if (path === '/campaigns/c1') return ok({ id: 'c1', name: 'QA', currency: 'USD', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_000, total_budget_amount_local_micro: null });
        if (path === '/line_items/l1') return ok({ id: 'l1', name: 'Preroll QA', campaign_id: 'c1', currency: 'USD', entity_status: 'PAUSED', deleted: false, placements: ['PUBLISHER_NETWORK'], product_type: 'MEDIA', objective: 'PREROLL_VIEWS' });
        if (path === '/account_media') return Response.json({ data: assets, next_cursor: null });
        if (path.startsWith('/account_media/')) return ok(assets.find(row => row.id === path.split('/').at(-1)));
        if (path === '/media_creatives') {
          const rows = associations.filter(row => q.get('with_deleted') === 'true' || !row.deleted), start = q.has('cursor') ? 1 : 0, count = Number(q.get('count') ?? 20);
          expect(q.get('line_item_ids')).toBe('l1');return Response.json({ data: rows.slice(start, start + count), next_cursor: start + count < rows.length ? 'page-two' : null });
        }
        if (path.startsWith('/media_creatives/')) return ok(associations.find(row => row.id === path.split('/').at(-1)));
      }
      mutations.push({ method: init.method!, path });
      if (path === '/media_creatives' && init.method === 'POST') { expect(Object.fromEntries(q)).toEqual({ line_item_id: 'l1', account_media_id: 'am3' });const row = { ...associations[0]!, id: 'mc3', account_media_id: 'am3', deleted: false };associations.push(row);return ok(row); }
      if (path === '/media_creatives/mc1' && init.method === 'DELETE') { associations[0]!.deleted = true;return ok(associations[0]); }
      throw new Error(`Unexpected synthetic endpoint ${init.method} ${path}`);
    }));
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: xTools(provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['x'] }], resolve: async value => { expect(value).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'x-direct-widget-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const call = async (name: string, args: Record<string, unknown>) => { const result = await host.callTool({ name, arguments: { project_id: project, account_id: account, ...args } });expect(result.isError).not.toBe(true);return result; };
      const callTool = vi.fn((name: string, args: Record<string, unknown>) => { expect(args.project_id).toBe(project);return call(name, args); });
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
      };
      const approve = async (view: Element, before: number) => { expect(mutations).toHaveLength(before);const button = view.querySelector('[data-approve]')!;button.dispatchEvent(new view.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));expect(mutations).toHaveLength(before);button.dispatchEvent(new view.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(view.querySelector('.operation-status')?.textContent).toBe('Applied'), { timeout: 3000 });expect(mutations).toHaveLength(before + 1); };
      const descriptors = (await host.listTools()).tools;
      for (const name of ['x_account_media', 'x_media_creatives', 'x_media_creative_context', 'x_create_media_creative', 'x_delete_media_creative']) expect(descriptors.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      const gallery = mount(await call('x_media_creatives', { line_item_id: 'l1', count: 1 })), grid = gallery.querySelector<HTMLElement>('[data-provider-gallery]')!, player = gallery.querySelector('video')!;grid.scrollTop = 63;player.currentTime = 7;
      expect(player.src).toBe(assets[0]!.media_url);expect(gallery.textContent).toContain('Media ad mc1');expect(gallery.querySelector('script')).toBeNull();
      gallery.querySelector<HTMLButtonElement>('[data-provider-more]')!.click();gallery.querySelector<HTMLButtonElement>('[data-provider-more]')!.click();await vi.waitFor(() => expect(gallery.querySelectorAll('article')).toHaveLength(2));expect(gallery.querySelector('video')).toBe(player);expect(player.currentTime).toBe(7);expect(grid.scrollTop).toBe(63);expect(callTool).toHaveBeenCalledTimes(1);
      gallery.querySelector<HTMLButtonElement>('[data-creative-action]')!.click();await vi.waitFor(() => expect(gallery.querySelector('[data-approve]')).not.toBeNull());expect(gallery.textContent).toContain('Account Media retained');expect(gallery.textContent).toContain('not source deletion');await approve(gallery, 0);
      expect(associations[0]).toMatchObject({ deleted: true, entity_status: 'ACTIVE' });expect(assets[0]!.deleted).toBe(false);
      const selection = { line_item_id: 'l1', account_media_id: 'am3' }, context = await call('x_media_creative_context', selection), view = mount(await call('x_create_media_creative', { ...selection, expected_context_hash: (context.structuredContent as Record<string, unknown>).context_hash, acknowledge_active_association: true }));
      expect(view.textContent).toContain('Native association status');expect(view.textContent).toContain('ACTIVE');expect(view.textContent).toContain('PAUSED');expect(view.textContent).toContain('Separate preroll CTA settings');await approve(view, 1);
      expect(associations[2]).toMatchObject({ id: 'mc3', account_media_id: 'am3', entity_status: 'ACTIVE', deleted: false });expect(assets.every(row => !row.deleted)).toBe(true);expect(mutations).toEqual([{ method: 'DELETE', path: '/media_creatives/mc1' }, { method: 'POST', path: '/media_creatives' }]);
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  }, 20_000);
});
