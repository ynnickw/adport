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

// Synthetic X endpoint + real SDK/DOM bridges, not actual Claude/ChatGPT tests.
describe.each(['mcp', 'openai'] as const)('X preroll CTA %s widget bridge', bridge => {
  it('browses pages cheaply, edits native preset/destination fields, and separately approves create/update/delete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-x-cta-widget-')), account = 'a1', project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0';
    const parent = { id: 'l1', name: 'Preroll QA', campaign_id: 'c1', currency: 'USD', entity_status: 'PAUSED', deleted: false, placements: ['PUBLISHER_NETWORK'], product_type: 'MEDIA', objective: 'PREROLL_VIEWS' };
    const rows: Array<{ id: string; line_item_id: string; call_to_action: string; call_to_action_url: string; deleted: boolean }> = [], mutations: Array<{ method: string; path: string; params: Record<string, string> }> = [], reads: string[] = [];
    const provider = new XAdsProvider(new XAdsClient({ consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' }, async (raw, init = {}) => {
      const url = new URL(String(raw)), path = url.pathname.replace(`/12/accounts/${account}`, ''), q = url.searchParams, ok = (data: unknown) => Response.json({ data });
      if (init.method === 'GET') {
        reads.push(path);
        if (!path) return ok({ id: account, name: 'QA', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false });
        if (path === '/campaigns/c1') return ok({ id: 'c1', name: 'QA', currency: 'USD', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_000, total_budget_amount_local_micro: null });
        if (path === '/line_items/l1') return ok(parent);
        if (path === '/preroll_call_to_actions') { if (q.has('line_item_ids')) expect(q.get('line_item_ids')).toBe('l1');const active = rows.filter(row => q.get('with_deleted') === 'true' || !row.deleted), start = q.has('cursor') ? 1 : 0, count = Number(q.get('count') ?? 20);return Response.json({ data: active.slice(start, start + count), next_cursor: start + count < active.length ? 'page-two' : null }); }
        if (path.startsWith('/preroll_call_to_actions/')) return ok(rows.find(row => row.id === path.split('/').at(-1)));
      }
      mutations.push({ method: init.method!, path, params: Object.fromEntries(q) });
      if (init.method === 'POST' && path === '/preroll_call_to_actions') { const row = { id: 'cta1', line_item_id: q.get('line_item_id')!, call_to_action: q.get('call_to_action')!, call_to_action_url: q.get('call_to_action_url')!, deleted: false };rows.push(row);return ok(row); }
      const row = rows.find(row => row.id === path.split('/').at(-1));
      if (row && init.method === 'PUT') { for (const key of ['call_to_action', 'call_to_action_url'] as const) if (q.has(key)) row[key] = q.get(key)!;return ok(row); }
      if (row && init.method === 'DELETE') { row.deleted = true;return ok(row); }
      throw new Error(`Unexpected synthetic endpoint ${init.method} ${path}`);
    }));
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: xTools(provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['x'] }], resolve: async value => { expect(value).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'x-cta-widget-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const call = async (name: string, args: Record<string, unknown>) => { const result = await host.callTool({ name, arguments: { project_id: project, account_id: account, ...args } });expect(result.isError).not.toBe(true);return result; };
      const callTool = vi.fn((name: string, args: Record<string, unknown>) => { expect(args.project_id).toBe(project);return call(name, args); });
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
      };
      const approve = async (view: Element, before: number) => { expect(mutations).toHaveLength(before);const button = view.querySelector('[data-approve]')!;expect(button).not.toBeNull();button.dispatchEvent(new view.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));expect(mutations).toHaveLength(before);button.dispatchEvent(new view.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(view.querySelector('.operation-status')?.textContent).toBe('Applied'), { timeout: 3000 });expect(mutations).toHaveLength(before + 1); };
      const descriptors = (await host.listTools()).tools;
      for (const name of ['x_preroll_ctas', 'x_get_preroll_cta', 'x_create_preroll_cta', 'x_update_preroll_cta', 'x_delete_preroll_cta']) expect(descriptors.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      const selection = { line_item_id: 'l1', call_to_action: 'VISIT_SITE', call_to_action_url: 'https://example.test/original?q=A%2BB' }, context = await call('x_preroll_cta_context', selection), creating = mount(await call('x_create_preroll_cta', { ...selection, expected_context_hash: (context.structuredContent as Record<string, unknown>).context_hash, acknowledge_ad_group_scope: true }));
      expect(creating.textContent).toContain('All preroll ads in this ad group');expect(creating.textContent).toContain('PAUSED');await approve(creating, 0);
      rows.push({ ...rows[0]!, id: 'cta2', call_to_action: 'WATCH_NOW' });parent.entity_status = 'ACTIVE';
      const before = reads.length, gallery = mount(await call('x_preroll_ctas', { count: 1 })), grid = gallery.querySelector<HTMLElement>('[data-provider-gallery]')!, first = gallery.querySelector('article');grid.scrollTop = 41;
      expect(reads.slice(before)).toEqual(['', '/preroll_call_to_actions']);expect(gallery.querySelector('[data-creative-action]')).toBeNull();
      gallery.querySelector<HTMLButtonElement>('[data-provider-more]')!.click();gallery.querySelector<HTMLButtonElement>('[data-provider-more]')!.click();await vi.waitFor(() => expect(gallery.querySelectorAll('article')).toHaveLength(2));expect(gallery.querySelector('article')).toBe(first);expect(grid.scrollTop).toBe(41);expect(callTool).toHaveBeenCalledTimes(2);
      const editing = mount(await call('x_get_preroll_cta', { preroll_call_to_action_id: 'cta1' }));editing.querySelector<HTMLButtonElement>('[data-creative-action]')!.click();
      expect(editing.querySelector<HTMLSelectElement>('[data-field="0"]')!.value).toBe('VISIT_SITE');const destination = 'https://next.test/deep?q=%3Ctag%3E&ref=A+B#section';editing.querySelector<HTMLInputElement>('[data-field="1"]')!.value = destination;
      editing.querySelector('form')!.dispatchEvent(new editing.ownerDocument.defaultView!.Event('submit', { bubbles: true, cancelable: true }));await vi.waitFor(() => expect(editing.querySelector('[data-approve]')).not.toBeNull());expect(editing.textContent).toContain('Destination');expect(editing.textContent).toContain('ACTIVE');expect(editing.querySelector('script')).toBeNull();await approve(editing, 1);
      expect(mutations[1]).toEqual({ method: 'PUT', path: '/preroll_call_to_actions/cta1', params: { call_to_action_url: destination } });expect(rows[0]!.call_to_action).toBe('VISIT_SITE');expect(parent.entity_status).toBe('ACTIVE');
      const removal = mount(await call('x_get_preroll_cta', { preroll_call_to_action_id: 'cta1' }));removal.querySelectorAll<HTMLButtonElement>('[data-creative-action]')[1]!.click();await vi.waitFor(() => expect(removal.querySelector('[data-approve]')).not.toBeNull());expect(removal.textContent).toContain('does not pause preroll ads');await approve(removal, 2);
      expect(rows[0]!.deleted).toBe(true);expect(rows[1]!.deleted).toBe(false);expect(parent.entity_status).toBe('ACTIVE');expect(mutations.map(row => row.method)).toEqual(['POST', 'PUT', 'DELETE']);
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  }, 20_000);
});
