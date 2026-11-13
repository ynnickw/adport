import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { xTools } from '../../x/src/tools.js';
import { A, L, U, U2, association, campaign, line, mutations, promotedAccountFixture } from '../../x/test/promoted-account-fixture.js';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Real SDK + synthetic native responses and DOM host bridges, not actual hosts.
describe.each(['openai', 'mcp'] as const)('X promoted-account %s widget bridge', bridge => {
  it('pages profile references in place and separately reviews removal/reassociation, respecting read-only grants', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-promoted-account-widget-')), project = 'b310e750-d001-4427-8184-09bd05920e01';
    const f = promotedAccountFixture({ associations: [association, { ...association, id: 'pa2', user_id: U2 }] });
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: xTools(f.provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['x'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'promoted-account-widget', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);
    const readServer = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read'] }), reader = new Client({ name: 'promoted-account-reader', version: '1' }), [rt, rst] = InMemoryTransport.createLinkedPair();await readServer.connect(rst);await reader.connect(rt);const doms: JSDOM[] = [];
    try {
      const call = async (name: string, args: Record<string, unknown>) => { const result = await host.callTool({ name, arguments: { project_id: project, account_id: A, ...args } });expect(result.isError).not.toBe(true);return result; };
      const callTool = vi.fn((name: string, args: Record<string, unknown>) => { expect(args.project_id).toBe(project);return call(name, args); });
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
      };
      const approve = async (view: Element, before: number) => { expect(mutations(f)).toHaveLength(before);const button = view.querySelector('[data-approve]')!;button.dispatchEvent(new view.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));expect(mutations(f)).toHaveLength(before);button.dispatchEvent(new view.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(view.querySelector('.operation-status')?.textContent).toBe('Applied'), { timeout: 3000 });expect(mutations(f)).toHaveLength(before + 1); };
      const definitions = (await host.listTools()).tools;
      for (const name of ['x_promoted_accounts', 'x_get_promoted_account', 'x_promoted_account_context', 'x_create_promoted_account', 'x_delete_promoted_account']) expect(definitions.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      expect((await reader.listTools()).tools.some(tool => ['x_create_promoted_account', 'x_delete_promoted_account'].includes(tool.name))).toBe(false);
      const readOnly = await reader.callTool({ name: 'x_promoted_accounts', arguments: { project_id: project, account_id: A, line_item_id: L } });expect(readOnly.isError).not.toBe(true);expect(mount(readOnly).querySelector('[data-creative-action]')).toBeNull();
      const gallery = mount(await call('x_promoted_accounts', { line_item_id: L, count: 1 })), grid = gallery.querySelector<HTMLElement>('[data-provider-gallery]')!, first = grid.querySelector('article')!;grid.scrollTop = 47;
      expect(gallery.textContent).toContain(U);expect(gallery.querySelector(`a[href="https://x.com/i/user/${U}"]`)).not.toBeNull();expect(gallery.querySelector('video')).toBeNull();
      gallery.querySelector<HTMLButtonElement>('[data-provider-more]')!.click();gallery.querySelector<HTMLButtonElement>('[data-provider-more]')!.click();await vi.waitFor(() => expect(grid.querySelectorAll('article')).toHaveLength(2));expect(grid.querySelector('article')).toBe(first);expect(grid.scrollTop).toBe(47);expect(callTool).toHaveBeenCalledTimes(1);
      gallery.querySelector<HTMLButtonElement>('[data-creative-action]')!.click();await vi.waitFor(() => expect(gallery.querySelector('[data-approve]')).not.toBeNull());expect(gallery.textContent).toContain('Profile retained');await approve(gallery, 0);expect(f.associations[0]).toMatchObject({ deleted: true, entity_status: 'ACTIVE' });expect(f.associations[1]!.deleted).toBe(false);
      const selection = { line_item_id: L, user_id: U }, context = await call('x_promoted_account_context', selection), review = mount(await call('x_create_promoted_account', { ...selection, expected_context_hash: (context.structuredContent as Record<string, unknown>).context_hash, acknowledge_active_association: true, acknowledge_live_profile: true }));
      expect(review.textContent).toContain('Live X profile');expect(review.textContent).toContain('ACTIVE');expect(review.textContent).toContain('PAUSED');await approve(review, 1);
      expect(mutations(f).map(call => ({ method: call.init.method, path: call.url.pathname }))).toEqual([{ method: 'DELETE', path: `/12/accounts/${A}/promoted_accounts/pa1` }, { method: 'POST', path: `/12/accounts/${A}/promoted_accounts` }]);
      expect(f.associations[2]).toMatchObject({ id: 'pa3', user_id: U, deleted: false, entity_status: 'ACTIVE' });expect(f.parent).toEqual(line);expect(f.funding).toEqual(campaign);
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await reader.close();await readServer.close();await rm(dir, { recursive: true, force: true }); }
  }, 20_000);
});
