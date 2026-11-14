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

// Provider-owned v12 audience reference4e8f626, inspected2026-11-05. No native requests.
describe('X custom-audience SDK and widget contract', () => {
  it('pages stable scoped records, reviews metadata and keeps member inputs out of host approvals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-x-audience-widget-')), account = '18ce0000qa1', project = 'b310e750-d001-4427-8184-09bd05920e01', resource = '2906h', calls: Array<{ url: URL; method: string }> = [];
    const source = { id: resource, name: 'QA <literal> audience', description: null, audience_type: 'CRM', deleted: false, permission_level: 'READ_WRITE', owner_account_id: account, targetable: false, audience_size: null };
    const provider = new XAdsProvider(new XAdsClient({ consumerKey: 'inert', consumerSecret: 'inert', accessToken: 'inert', accessTokenSecret: 'inert' }, async (input, init = {}) => {
      const url = new URL(String(input));calls.push({ url, method: String(init.method) });
      if (init.method !== 'GET') throw new Error('Widget tests must not mutate');
      if (url.pathname === `/12/accounts/${account}`) return Response.json({ data: { id: account, name: 'QA', approval_status: 'ACCEPTED', timezone: 'UTC', deleted: false } });
      if (url.pathname === `/12/accounts/${account}/custom_audiences/${resource}`) return Response.json({ data: source });
      if (url.pathname === `/12/accounts/${account}/custom_audiences`) return Response.json(url.searchParams.has('cursor') ? { data: [{ ...source, id: '2906j', name: 'QA second audience' }], next_cursor: null } : { data: [source], next_cursor: 'native-next', total_count: 2 });
      throw new Error('Unexpected resource');
    }));
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: xTools(provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['x'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'x-audience-widget-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const tools = (await host.listTools()).tools;expect(tools.find(tool => tool.name === 'x_custom_audiences')?.outputSchema).toMatchObject({ type: 'object', properties: { records: { type: 'array' } } });
      expect(tools.find(tool => tool.name === 'x_custom_audiences')?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      expect(ADPORT_UI_URI).not.toBe('ui://adport/insight-card-v20.html');
      for (const uri of [ADPORT_UI_URI, 'ui://adport/insight-card-v20.html']) expect((await host.readResource({ uri })).contents[0]).toMatchObject({ text: expect.stringContaining('Array.isArray(data.records)') });
      const args = { project_id: project, account_id: account, count: 1, q: 'QA', permission_scope: 'OWNER', with_deleted: false, with_total_count: true }, initial = await host.callTool({ name: 'x_custom_audiences', arguments: args });expect(initial.isError).not.toBe(true);
      expect(initial.structuredContent).toMatchObject({ _adport: { context: { project_id: project }, next: { arguments: { ...args, cursor: 'native-next' } } } });
      const callTool = vi.fn(async (name: string, input: Record<string, unknown>) => host.callTool({ name, arguments: input }));
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } });doms.push(dom);
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
      };
      const main = mount(initial), root = main.querySelector<HTMLElement>('[data-record-list]')!, first = root.firstElementChild;root.scrollTop = 17;
      expect(main.textContent).toContain(source.name);expect(main.querySelector('.record-heading > span')?.textContent).toBe('Not targetable');expect(root.textContent).toContain('Audience size');expect(root.textContent).toContain('Not reported');expect(main.querySelector('literal')).toBeNull();main.querySelector<HTMLButtonElement>('[data-record-more]')!.click();
      await vi.waitFor(() => expect(main.textContent).toContain('QA second audience'));expect(root.firstElementChild).toBe(first);expect(root.scrollTop).toBe(17);expect(main.querySelectorAll('article')).toHaveLength(2);expect(main.querySelector('[data-record-more]')).toBeNull();
      expect(callTool).toHaveBeenCalledTimes(1);expect(callTool).toHaveBeenCalledWith('x_custom_audiences', { ...args, cursor: 'native-next' });
      expect(calls.find(call => call.url.searchParams.has('cursor'))!.url.searchParams.has('with_total_count')).toBe(false);
      const continuation = await callTool.mock.results[0]!.value, firstData = initial.structuredContent as { records: unknown[] }, lastData = continuation.structuredContent as { records: unknown[] };
      const restored = mount({ ...continuation, structuredContent: { ...lastData, records: [...firstData.records, ...lastData.records] } });
      expect(restored.querySelectorAll('article')).toHaveLength(2);expect(restored.textContent).toContain(source.name);expect(restored.textContent).toContain('QA second audience');
      const current = (await provider.audiences.get({ account_id: account, custom_audience_id: resource })).audience;
      const preview = await host.callTool({ name: 'x_update_custom_audience', arguments: { project_id: project, account_id: account, custom_audience_id: resource, expected_configuration_hash: current.configuration_hash, name: 'QA renamed' } });
      expect(preview.isError).not.toBe(true);const review = mount(preview);expect(review.querySelector('.review-before')?.textContent).toBe(source.name);expect(review.querySelector('.review-after')?.textContent).toBe('QA renamed');expect(review.querySelector('[data-approve]')?.textContent).toBe('Hold to apply');
      const members = await host.callTool({ name: 'x_update_custom_audience_users', arguments: { project_id: project, account_id: account, custom_audience_id: resource, expected_configuration_hash: current.configuration_hash, operations: [{ operation_type: 'Update', params: { users: [{ email: ['a'.repeat(64)], partner_user_id: ['private-partner-id'] }] } }] } });
      expect(members.isError).not.toBe(true);expect(((members.structuredContent as Record<string, unknown>)._adport as Record<string, unknown>).approval).toBeUndefined();
      for (const secret of ['a'.repeat(64), 'private-partner-id']) expect(JSON.stringify(members)).not.toContain(secret);expect(mount(members).textContent).toContain('1 user record');expect(calls.every(call => call.method === 'GET')).toBe(true);
    } finally { for (const dom of doms) dom.window.close();await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  });
});
