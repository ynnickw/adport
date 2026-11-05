import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { createContext, withProjectRouting } from '@adport/core';
import { TikTokClient, TikTokAdsProvider, tiktokTools } from '@adport/provider-tiktok';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML } from '../src/ui.js';

const project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0', account = '7678335757387513873', ruleId = '9007199254740993123', execId = '9007199254740993124';

// Native TikTok v1.3 rule/list, rule/get and rule/result/get contracts, inspected 2026-11-05.
describe('TikTok rule inspection SDK and native widget protocol', () => {
  it('retains project/filter scope and existing cards while loading another native page', async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const provider = new TikTokAdsProvider(new TikTokClient({ accessToken: 'inert-only' }, (async (url, init = {}) => {
      const target = new URL(String(url));calls.push({ url: target, init });
      if (init.method !== 'GET' || target.searchParams.get('advertiser_id') !== account) throw new Error('Unexpected mutation or account');
      const data = target.pathname.endsWith('/result/get/') ? { result_details: [{ rule_id: ruleId, exec_id: execId, object_name: 'QA <campaign>', object_dimension_id: '123', object_dimension: 'CAMPAIGN', status: 'SUCCESS' }] }
        : { rules: [{ rule_id: target.searchParams.get('page') === '2' ? '9007199254740993125' : ruleId, name: target.searchParams.get('page') === '2' ? 'Second QA rule' : 'QA <literal> rule', rule_status: 'OFF', actions: [{ subject_type: 'MESSAGE' }], rule_exec_info: { exec_time_type: 'CUSTOM', exec_time: '12:00' } }], page_info: { page: Number(target.searchParams.get('page') ?? 1), page_size: 1, total_number: 2, total_page: 2 } };
      return Response.json({ code: 0, message: 'OK', data });
    }) as typeof fetch), { appId: 'inert', secret: 'inert' });
    const base = await createContext({ providerModules: [{ provider, tools: tiktokTools(provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['tiktok'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, scopes: ['tools:read'] }), host = new Client({ name: 'tiktok-rule-widget-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);await host.connect(ct);let dom: JSDOM | undefined;
    try {
      const tools = (await host.listTools()).tools, selected = tools.filter(tool => tool.name.includes('automated_rule'));
      expect(selected).toHaveLength(4);for (const tool of selected) expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      const args = { project_id: project, account_id: account, filtering: { status: 'OFF', rule_info: ['QA'] }, tzone: 'UTC', page_size: 1 };
      const list = await host.callTool({ name: 'tiktok_automated_rules', arguments: args });
      expect(list.isError).not.toBe(true);expect(list.structuredContent).toMatchObject({ records: [{ id: ruleId, status: 'OFF' }], _adport: { view: 'records', context: { project_id: project }, next: { arguments: { ...args, page: 2 } } } });
      const callTool = vi.fn(async (name: string, input: Record<string, unknown>) => host.callTool({ name, arguments: input }));
      dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } });
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: list } }));
      const main = dom.window.document.querySelector('main')!, root = main.querySelector<HTMLElement>('[data-record-list]')!, first = root.firstElementChild;
      expect(main.textContent).toContain('QA <literal> rule');expect(main.querySelector('literal')).toBeNull();expect(main.textContent).toContain('OFF');expect(main.querySelector('input,form,select,[data-approve]')).toBeNull();root.scrollTop = 33;
      main.querySelector<HTMLButtonElement>('[data-record-more]')!.click();
      await vi.waitFor(() => expect(main.textContent).toContain('Second QA rule'));
      expect(root.firstElementChild).toBe(first);expect(root.scrollTop).toBe(33);expect(main.querySelectorAll('article')).toHaveLength(2);expect(main.querySelector('[data-record-more]')).toBeNull();
      expect(callTool).toHaveBeenCalledTimes(1);expect(callTool).toHaveBeenCalledWith('tiktok_automated_rules', { ...args, page: 2 });
      const details = await host.callTool({ name: 'tiktok_automated_rule_result_details', arguments: { project_id: project, account_id: account, result_detail: [{ rule_id: ruleId, exec_id: execId }] } });
      expect(details.isError).not.toBe(true);expect(details.structuredContent).toMatchObject({ records: [{ rule_id: ruleId, exec_id: execId, object_name: 'QA <campaign>' }], complete: null, _adport: { view: 'records' } });
      expect(calls.every(call => call.init.method === 'GET')).toBe(true);
    } finally { dom?.window.close();await host.close();await server.close(); }
  });
});
