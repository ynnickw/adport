import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { tiktokTools } from '../../tiktok/src/tools.js';
import { customAudienceFixture, CUSTOM_ACCOUNT, CUSTOM_AUDIENCE, NEW_CUSTOM_AUDIENCE, syntheticHash } from '../../tiktok/test/custom-audience-fixture.js';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Shared registry and actual SDK transports; native responses and host bridges
// are synthetic, separately from required actual Claude/ChatGPT checks.
describe('TikTok customer audience SDK/widgets', () => {
  it.each(['openai', 'mcp'] as const)('pages native records, keeps upload contents private and distinguishes processing via %s', async bridge => {
    const f = customAudienceFixture(), dir = await mkdtemp(join(tmpdir(), 'tiktok-custom-widget-')), project = 'b310e750-d001-4427-8184-09bd05920e01', scope = { project_id: project, account_id: CUSTOM_ACCOUNT };
    f.state.rows.push({ ...f.state.rows[0], audience_id: '9007199254740993125', name: 'Second audience' });
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider) }] }), runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['tiktok'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'tiktok-custom-widget-qa', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [], applied = new Map<string, any>();
    const call = async (name: string, args: Record<string, unknown>) => { const result = await host.callTool({ name, arguments: args });expect(result.isError).not.toBe(true);return result; }, callTool = vi.fn(async (name: string, args: Record<string, unknown>) => { const result = await call(name, args);applied.set(name, result);return result; });
    const mount = (result: unknown) => {
      const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
      if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
    };
    try {
      const names = ['tiktok_custom_audiences', 'tiktok_get_custom_audience', 'tiktok_upload_audience_file', 'tiktok_create_customer_audience', 'tiktok_update_customer_audience_users', 'tiktok_rename_custom_audience', 'tiktok_delete_custom_audiences'], tools = (await host.listTools()).tools;
      for (const name of names) { expect(tools.filter(tool => tool.name === name)).toHaveLength(1);expect(tools.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI); }
      const first = mount(await call('tiktok_custom_audiences', { ...scope, page_size: 1 })), card = first.querySelector('[data-record-list]>article'), list = first.querySelector<HTMLElement>('[data-record-list]')!;list.scrollTop = 40;first.querySelector<HTMLButtonElement>('[data-record-more]')!.click();first.querySelector<HTMLButtonElement>('[data-record-more]')!.click();await vi.waitFor(() => expect(first.textContent).toContain('Second audience'));expect(first.querySelector('[data-record-list]>article')).toBe(card);expect(list.scrollTop).toBe(40);expect(callTool).toHaveBeenCalledTimes(1);expect(callTool).toHaveBeenLastCalledWith('tiktok_custom_audiences', expect.objectContaining({ ...scope, page_size: 1, page: 2 }));
      const reviewApply = async (name: string, payload: Record<string, unknown>, phase: string, labels: string[]) => {
        const args = { ...scope, ...payload }, count = f.writes().length, preview = await call(name, args);expect(f.writes()).toHaveLength(count);expect(JSON.stringify(preview)).not.toContain(syntheticHash);const view = mount(preview);
        for (const label of labels) expect(view.textContent).toContain(label);expect(Reflect.get(view.ownerDocument.defaultView!, 'executed')).toBeUndefined();view.querySelector<HTMLButtonElement>('[data-approve]')!.dispatchEvent(new view.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(view.querySelector('.operation-status')?.textContent).toBe(phase), { timeout: 3000 });expect(callTool).toHaveBeenLastCalledWith(name, expect.objectContaining({ ...args, pending_operation_id: expect.any(String) }));expect(f.writes()).toHaveLength(count + 1);return applied.get(name).structuredContent as any;
      };
      const upload = await reviewApply('tiktok_upload_audience_file', f.upload(), 'Applied', ['Upload customer audience file', 'EMAIL_SHA256', 'Rows']);expect(upload.result.details).not.toHaveProperty('file_path');const receipt = upload.result.details.upload_receipt;
      await reviewApply('tiktok_create_customer_audience', { custom_audience_name: 'QA <script>globalThis.executed=true</script>', upload_receipts: [receipt] }, 'Processing pending', ['Create customer audience', 'Disabled', 'approved']);
      f.state.rows.find(row => row.audience_id === NEW_CUSTOM_AUDIENCE)!.is_valid = true;
      const get = async () => (await call('tiktok_get_custom_audience', { ...scope, custom_audience_id: NEW_CUSTOM_AUDIENCE })).structuredContent as any;
      await reviewApply('tiktok_rename_custom_audience', { custom_audience_id: NEW_CUSTOM_AUDIENCE, expected_snapshot_hash: (await get()).audience.snapshot_hash, acknowledge_shared_effects: true, custom_audience_name: 'Edited audience' }, 'Applied with warnings', ['Rename custom audience', 'Edited audience']);
      await reviewApply('tiktok_update_customer_audience_users', { custom_audience_id: NEW_CUSTOM_AUDIENCE, expected_snapshot_hash: (await get()).audience.snapshot_hash, acknowledge_shared_effects: true, action: 'APPEND', upload_receipts: [receipt] }, 'Processing pending', ['Update customer audience members', 'APPEND', 'matched users']);
      const current = (await get()).audience;await reviewApply('tiktok_delete_custom_audiences', { targets: [{ custom_audience_id: NEW_CUSTOM_AUDIENCE, expected_snapshot_hash: current.snapshot_hash, confirm_name: current.name }], acknowledge_shared_effects: true, acknowledge_permanent_deletion: true }, 'Applied with warnings', ['Delete custom audiences permanently', 'Edited audience']);expect(f.state.rows.some(row => row.audience_id === NEW_CUSTOM_AUDIENCE)).toBe(false);expect(f.state.rows.some(row => row.audience_id === CUSTOM_AUDIENCE)).toBe(true);expect(f.writes()).toHaveLength(5);
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  }, 20_000);
});
