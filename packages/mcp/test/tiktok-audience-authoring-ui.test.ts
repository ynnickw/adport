import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { tiktokTools } from '../../tiktok/src/tools.js';
import { audienceAuthoringFixture, ruleInput, sourceIdentity } from '../../tiktok/test/audience-authoring-fixture.js';
import { CUSTOM_ACCOUNT } from '../../tiktok/test/custom-audience-fixture.js';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Actual MCP SDK transport and shared widget; host bridges and native data are
// synthetic. This does not establish actual Claude/ChatGPT host verification.
describe('TikTok audience authoring SDK/widgets', () => {
  it.each(['openai', 'mcp'] as const)('pages source/identity records and applies reviewed audiences via %s', async bridge => {
    const f = audienceAuthoringFixture(), dir = await mkdtemp(join(tmpdir(), 'tiktok-authoring-widget-')), project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0', scope = { project_id: project, account_id: CUSTOM_ACCOUNT };
    f.sourceState.apps.push({ ...f.sourceState.apps[0], app_id: 'second-app', app_name: 'Second app' });
    f.sourceState.identities.push({ ...f.sourceState.identities[0], identity_id: 'second-identity', display_name: 'Second identity' });
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider) }] }), runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['tiktok'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'tiktok-authoring-widget-qa', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [], applied = new Map<string, any>();
    const call = async (name: string, args: Record<string, unknown>) => { const result = await host.callTool({ name, arguments: args });expect(result.isError).not.toBe(true);return result; }, callTool = vi.fn(async (name: string, args: Record<string, unknown>) => { const result = await call(name, args);applied.set(name, result);return result; });
    const mount = (result: unknown) => {
      const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
      if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
    };
    try {
      const names = ['tiktok_identities', 'tiktok_audience_sources', 'tiktok_rule_audience_context', 'tiktok_create_rule_audience', 'tiktok_create_lookalike_audience', 'tiktok_refresh_lookalike_audiences'], tools = (await host.listTools()).tools;
      for (const name of names) { expect(tools.filter(tool => tool.name === name)).toHaveLength(1);expect(tools.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI); }
      const more = async (name: string, payload: Record<string, unknown>, nextName: string, nextArgs: Record<string, unknown>) => {
        const view = mount(await call(name, { ...scope, ...payload })), list = view.querySelector<HTMLElement>('[data-record-list]')!, card = list.firstElementChild, count = callTool.mock.calls.length;list.scrollTop = 41;
        view.querySelector<HTMLButtonElement>('[data-record-more]')!.click();view.querySelector<HTMLButtonElement>('[data-record-more]')!.click();await vi.waitFor(() => expect(view.textContent).toContain(nextName));expect(list.firstElementChild).toBe(card);expect(list.scrollTop).toBe(41);expect(callTool).toHaveBeenCalledTimes(count + 1);expect(callTool).toHaveBeenLastCalledWith(name, expect.objectContaining({ ...scope, ...payload, ...nextArgs }));expect(Reflect.get(view.ownerDocument.defaultView!, 'executed')).toBeUndefined();
      };
      await more('tiktok_audience_sources', { source_type: 'APP', page_size: 1 }, 'Second app', { cursor: expect.any(String) });
      await more('tiktok_identities', { identity_type: sourceIdentity.identity_type, identity_authorized_bc_id: sourceIdentity.identity_authorized_bc_id, page_size: 1 }, 'Second identity', { page: 2 });
      const reviewApply = async (name: string, payload: Record<string, unknown>, labels: string[]) => {
        const args = { ...scope, ...payload }, count = f.writes().length, preview = await call(name, args);expect(f.writes()).toHaveLength(count);const view = mount(preview);for (const label of labels) expect(view.textContent).toContain(label);
        view.querySelector<HTMLButtonElement>('[data-approve]')!.dispatchEvent(new view.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(view.querySelector('.operation-status')?.textContent).toBe('Processing pending'), { timeout: 3000 });expect(callTool).toHaveBeenLastCalledWith(name, expect.objectContaining({ ...args, pending_operation_id: expect.any(String) }));expect(f.writes()).toHaveLength(count + 1);expect(Reflect.get(view.ownerDocument.defaultView!, 'executed')).toBeUndefined();return { view, result: applied.get(name).structuredContent as any };
      };
      const selection = ruleInput();selection.rule_spec.inclusion_rule_set.rules[0].filter_set.filters[0].parameter_filters = [{ field: 'URL', operator: 'CONTAINS', values: ['/checkout <script>globalThis.executed=true</script>'] }, { field: 'VALUE', operator: 'IS_GREATER_THAN_OR_EQUAL_TO', values: ['25.00'] }];const context = (await call('tiktok_rule_audience_context', { ...scope, ...selection })).structuredContent as any;expect(mount({ structuredContent: context }).textContent).toContain('QA pixel');
      f.sourceState.echo = 'legacy';const rule = await reviewApply('tiktok_create_rule_audience', { ...selection, expected_context_hash: context.context_hash, custom_audience_name: 'QA <script>globalThis.executed=true</script>', is_auto_refresh: false }, ['Create rule audience', 'Include any', 'Disabled', 'All conditions', 'Any values', 'CONTAINS', '25.00', 'event AND every parameter condition']);expect(rule.result.result.details).toMatchObject({ rule_readback: 'UNCONFIRMED_NATIVE_REPRESENTATION', processed: false });expect(rule.view.textContent).toContain('UNCONFIRMED_NATIVE_REPRESENTATION');expect(rule.view.querySelector('script')).toBeNull();expect(f.writes()[0]!.body!.rule_spec).toEqual(selection.rule_spec);
      f.sourceState.echo = 'modern';f.sourceState.createdId = '9007199254740993125';const lookalike = await reviewApply('tiktok_create_lookalike_audience', await f.lookalike(), ['Create lookalike audience', 'Seed audience', 'Locations']);expect(lookalike.result.result.details.specification_readback).toBe('VERIFIED_NATIVE_ECHO');
      const created = f.state.rows.find(row => row.audience_id === f.sourceState.createdId)!;created.is_valid = true;const read = (await call('tiktok_get_custom_audience', { ...scope, custom_audience_id: created.audience_id })).structuredContent as any;
      const refresh = await reviewApply('tiktok_refresh_lookalike_audiences', { targets: [{ custom_audience_id: created.audience_id, expected_snapshot_hash: read.audience.snapshot_hash }], acknowledge_shared_effects: true }, ['Refresh lookalike audiences', 'Recompute native lookalike membership']);expect(refresh.result.result.details).toMatchObject({ accepted_count: 1, processed: false, metadata_preservation: 'VERIFIED', membership_verified: false });expect(f.writes()).toHaveLength(3);
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  }, 20_000);
});
