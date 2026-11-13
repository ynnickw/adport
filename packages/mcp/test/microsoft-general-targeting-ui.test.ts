import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { microsoftTools } from '../../microsoft/src/tools.js';
import { generalFixture, GENERAL_ACCOUNT, groupSelection } from '../../microsoft/test/general-targeting-fixture.js';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Real SDK/shared schema, synthetic native/host bridges; no actual Claude/ChatGPT claim.
describe('Microsoft general targeting SDK/widgets', () => {
  it.each(['openai', 'mcp'] as const)('pages stable inherited records and reviews effective geo changes via %s', async bridge => {
    const dir = await mkdtemp(join(tmpdir(), 'microsoft-general-widget-')), project = 'b310e750-d001-4427-8184-09bd05920e01', f = generalFixture(), before = structuredClone(f.state);
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: microsoftTools(f.provider) }] }), runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['microsoft'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'microsoft-general-widget-qa', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    const call = async (name: string, args: Record<string, unknown>) => { const result = await host.callTool({ name, arguments: { account_id: GENERAL_ACCOUNT, project_id: project, ...args } });expect(result.isError).not.toBe(true);return result; }, callTool = vi.fn((name: string, args: Record<string, unknown>) => call(name, args));
    const mount = (result: unknown) => { const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
      if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!; };
    try {
      for (const name of ['microsoft_targeting_context', 'microsoft_update_targeting']) expect((await host.listTools()).tools.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      const first = await call('microsoft_targeting_context', { target: groupSelection, page_size: 1 }), list = mount(first), rows = list.querySelector<HTMLElement>('[data-record-list]')!, firstRow = rows.firstElementChild;rows.scrollTop = 57;expect(list.textContent).toContain('Location 190');list.querySelector<HTMLButtonElement>('[data-record-more]')!.click();list.querySelector<HTMLButtonElement>('[data-record-more]')!.click();await vi.waitFor(() => expect(list.textContent).toContain('People In'));expect(rows.firstElementChild).toBe(firstRow);expect(rows.scrollTop).toBe(57);expect(callTool).toHaveBeenCalledTimes(1);
      const args = { target: groupSelection, expected_context_hash: (first.structuredContent as any).context_hash, acknowledge_delivery_effects: true, change: { action: 'add', targets: [{ type: 'Location', location_id: '999', exclude: true }] } }, pending = await call('microsoft_update_targeting', args), review = mount(pending);
      expect(review.textContent).toContain('<Native QA campaign>');expect(review.textContent).toContain('<Native QA group>');expect(review.querySelector('native')).toBeNull();expect(review.textContent).toContain('Geographic reach');expect(review.textContent).toContain('No positive location/radius restriction');expect(review.textContent).toContain('Schedule clock');expect(f.writes()).toEqual([]);
      const approve = review.querySelector<HTMLButtonElement>('[data-approve]')!;expect(approve).not.toBeNull();approve.dispatchEvent(new review.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(review.querySelector('.operation-status')?.textContent).toBe('Applied'), { timeout: 3000 });expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.body.AdGroupCriterions[0].Type).toBe('NegativeAdGroupCriterion');expect(f.state.campaign).toEqual(before.campaign);expect(f.state.group).toEqual(before.group);expect(f.state.campaignCriteria).toEqual(before.campaignCriteria);
      const next = await call('microsoft_targeting_context', { target: groupSelection });expect((next.structuredContent as any).inheritance.Location.source).toBe('AdGroup');expect((next.structuredContent as any).records.find((row: any) => row.id === 'Campaign:101').effective).toBe(false);
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  }, 25_000);
});
