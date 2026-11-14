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

// Real SDK and shared DOM bridges over synthetic native responses, not live hosts.
describe.each(['mcp', 'openai'] as const)('X Account Media %s widget bridge', bridge => {
  it('reviews dependencies and composes separately approved disassociation/source deletion, with read-only access enforced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-account-media-widget-')), account = 'a1', project = 'b310e750-d001-4427-8184-09bd05920e01';
    const assets = [1, 2, 3].map(index => ({ id: 'am' + index, creative_type: 'PREROLL', video_id: '13_77179171717546803' + index, media_url: 'https://video.twimg.com/qa-' + index + '.mp4', deleted: false }));
    const associations = [{ id: 'mc1', line_item_id: 'l1', account_media_id: 'am1', creative_type: 'PREROLL', landing_url: null, entity_status: 'ACTIVE', deleted: false }, { id: 'mc2', line_item_id: 'l2', account_media_id: 'am3', creative_type: 'PREROLL', landing_url: null, entity_status: 'ACTIVE', deleted: false }];
    const parent = { id: 'l1', name: 'Preroll QA', campaign_id: 'c1', currency: 'USD', entity_status: 'PAUSED', deleted: false, placements: ['PUBLISHER_NETWORK'], product_type: 'MEDIA', objective: 'PREROLL_VIEWS' }, campaign = { id: 'c1', name: 'QA', currency: 'USD', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_000, total_budget_amount_local_micro: null };
    const mutations: string[] = [];
    const provider = new XAdsProvider(new XAdsClient({ consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' }, async (raw, init = {}) => {
      const url = new URL(String(raw)), path = url.pathname.replace(`/12/accounts/${account}`, ''), ok = (data: unknown) => Response.json({ data });
      if (init.method === 'GET') {
        if (!path) return ok({ id: account, name: 'QA', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false });
        if (path.startsWith('/account_media/')) return ok(assets.find(row => row.id === path.split('/').at(-1)));
        if (path === '/media_creatives') return Response.json({ data: associations.filter(row => (!url.searchParams.has('line_item_ids') || row.line_item_id === url.searchParams.get('line_item_ids')) && (url.searchParams.get('with_deleted') === 'true' || !row.deleted)), next_cursor: null });
        if (path === '/media_creatives/mc1') return ok(associations[0]);
        if (path === '/line_items/l1') return ok(parent);
        if (path === '/campaigns/c1') return ok(campaign);
      }
      expect(init.method).toBe('DELETE');expect(url.search).toBe('');expect(init.body).toBeUndefined();mutations.push(path);
      if (path === '/media_creatives/mc1') { associations[0]!.deleted = true;return ok(associations[0]); }
      if (path === '/account_media/am1' || path === '/account_media/am2') { const row = assets.find(row => path.endsWith('/' + row.id))!;row.deleted = true;return ok(row); }
      throw new Error(`Unexpected synthetic endpoint ${init.method} ${path}`);
    }));
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: xTools(provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['x'] }], resolve: async value => { expect(value).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'account-media-widget', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);
    const readServer = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read'] }), reader = new Client({ name: 'account-media-reader', version: '1' }), [rt, rst] = InMemoryTransport.createLinkedPair();await readServer.connect(rst);await reader.connect(rt);const doms: JSDOM[] = [];
    try {
      const call = async (name: string, args: Record<string, unknown>) => { const result = await host.callTool({ name, arguments: { project_id: project, account_id: account, ...args } });expect(result.isError).not.toBe(true);return result; };
      const callTool = vi.fn((name: string, args: Record<string, unknown>) => { expect(args.project_id).toBe(project);return call(name, args); });
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
      };
      const approve = async (view: Element, before: number) => { expect(mutations).toHaveLength(before);const button = view.querySelector('[data-approve]')!;button.dispatchEvent(new view.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));expect(mutations).toHaveLength(before);button.dispatchEvent(new view.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(view.querySelector('.operation-status')?.textContent).toBe('Applied'), { timeout: 3000 });expect(mutations).toHaveLength(before + 1); };
      for (const name of ['x_account_media_usage', 'x_delete_account_media']) expect((await host.listTools()).tools.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      expect((await reader.listTools()).tools.some(tool => tool.name === 'x_delete_account_media')).toBe(false);
      const readOnly = await reader.callTool({ name: 'x_account_media_usage', arguments: { project_id: project, account_id: account, account_media_id: 'am2' } });expect(readOnly.isError).not.toBe(true);expect(mount(readOnly).querySelector('[data-creative-action]')).toBeNull();expect(mutations).toEqual([]);
      const used = await call('x_account_media_usage', { account_media_id: 'am1' });expect(used.structuredContent).toMatchObject({ can_delete: false, non_deleted_references: 1 });expect(mount(used).querySelector('[data-creative-action]')).toBeNull();
      const unused = mount(await call('x_account_media_usage', { account_media_id: 'am2' }));expect(unused.querySelector('video')?.src).toBe(assets[1]!.media_url);unused.querySelector<HTMLButtonElement>('[data-creative-action]')!.click();await vi.waitFor(() => expect(unused.querySelector('[data-approve]')).not.toBeNull());expect(unused.textContent).toContain('Delete Account Media');expect(unused.textContent).toContain('not a reversible ad pause');await approve(unused, 0);expect(assets[1]!.deleted).toBe(true);expect(associations.every(row => !row.deleted)).toBe(true);
      const current = await call('x_get_media_creative', { media_creative_id: 'mc1' }), detach = mount(await call('x_delete_media_creative', { media_creative_id: 'mc1', expected_context_hash: (current.structuredContent as Record<string, unknown>).context_hash }));await approve(detach, 1);expect(assets[0]!.deleted).toBe(false);
      const available = mount(await call('x_account_media_usage', { account_media_id: 'am1' }));available.querySelector<HTMLButtonElement>('[data-creative-action]')!.click();await vi.waitFor(() => expect(available.querySelector('[data-approve]')).not.toBeNull());await approve(available, 2);
      expect(mutations).toEqual(['/account_media/am2', '/media_creatives/mc1', '/account_media/am1']);expect(assets.map(row => row.deleted)).toEqual([true, true, false]);expect(associations[1]!.deleted).toBe(false);expect(parent.entity_status).toBe('PAUSED');expect(campaign.daily_budget_amount_local_micro).toBe(10_000_000);
      const deleted = mount(await call('x_account_media_usage', { account_media_id: 'am1' }));expect(deleted.querySelector('[data-creative-action]')).toBeNull();expect(deleted.querySelector('video')).toBeNull();
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await reader.close();await readServer.close();await rm(dir, { recursive: true, force: true }); }
  }, 25_000);
});
