import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { offlineEvent, offlineFixture, OFFLINE_ACCOUNT, OFFLINE_NOW } from '../../microsoft/test/offline-conversion-fixture.js';
import { microsoftTools } from '../../microsoft/src/tools.js';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Shared registry + real SDK, with synthetic native responses and host bridges.
// These checks do not claim actual Claude/ChatGPT execution or native event ingestion.
describe('private Microsoft offline reviews and processing receipts', () => {
  it.each(['openai', 'mcp'] as const)('keeps private arguments in the agent and renders pending processing via %s', async bridge => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(OFFLINE_NOW));
    const dir = await mkdtemp(join(tmpdir(), 'microsoft-offline-widget-')), project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0';
    const f = offlineFixture(call => call.path === 'OfflineConversions/Apply' ? { PartialErrors: [{ Index: 1, Code: 5010, Message: offlineEvent.microsoft_click_id, Details: 'private native response' }] } : undefined), before = structuredClone(f.state);
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: microsoftTools(f.provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['microsoft'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'microsoft-offline-widget-qa', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [], callTool = vi.fn();
    const call = async (name: string, args: Record<string, unknown>) => { const result = await host.callTool({ name, arguments: { project_id: project, account_id: OFFLINE_ACCOUNT, ...args } });expect(result.isError).not.toBe(true);return result; };
    const mount = (result: unknown) => {
      const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
    };
    try {
      const defs = (await host.listTools()).tools;
      for (const name of ['microsoft_upload_offline_conversions', 'microsoft_upload_offline_conversion_adjustments']) expect(defs.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      const args = await f.args({ conversions: [offlineEvent, { hashed_email_address: 'a'.repeat(64), conversion_time: offlineEvent.conversion_time }] }), preview = await call('microsoft_upload_offline_conversions', args), view = mount(preview), content = preview.structuredContent as any;
      expect(content._adport.approval).toBeUndefined();expect(view.textContent).toContain('Import offline conversions');expect(view.textContent).toContain('<Owned offline goal>');expect(view.querySelector('owned')).toBeNull();expect(view.textContent).toContain('Explicit value ranges');expect(view.textContent).toContain('12.34');expect(view.textContent).not.toContain(offlineEvent.microsoft_click_id);expect(view.textContent).not.toContain('a'.repeat(64));expect(JSON.stringify(preview)).not.toContain(offlineEvent.microsoft_click_id);expect(JSON.stringify(preview)).not.toContain('a'.repeat(64));expect(view.querySelector('[data-approve]')).toBeNull();expect(f.writes()).toEqual([]);
      const applied = await call('microsoft_upload_offline_conversions', { ...args, pending_operation_id: content.pending_operation_id }), receipt = mount(applied), result = (applied.structuredContent as any).result;
      expect(receipt.textContent).toContain('Processing pending');expect(receipt.textContent).toContain('Processing is not confirmed');expect(receipt.textContent).toContain('1 of 2');expect(receipt.textContent).not.toContain('private native response');expect(result.details).toMatchObject({ processed: false, accepted_count: 1, failed_count: 1, rows: [{ index: 0, status: 'ACCEPTED' }, { index: 1, status: 'FAILED' }] });expect(f.writes()).toHaveLength(1);
      const replay = await host.callTool({ name: 'microsoft_upload_offline_conversions', arguments: { project_id: project, account_id: OFFLINE_ACCOUNT, ...args, pending_operation_id: content.pending_operation_id } });expect(replay.isError).toBe(true);expect(f.writes()).toHaveLength(1);
      const adjustmentArgs = { goal_id: args.goal_id, expected_goal_hash: args.expected_goal_hash, acknowledge_measurement_effects: true, adjustments: [{ microsoft_click_id: offlineEvent.microsoft_click_id, conversion_time: offlineEvent.conversion_time, adjustment_time: '2026-11-06T01:00:00Z', adjustment_type: 'Restate', adjustment_value: 0, adjustment_currency_code: 'USD' }] };
      const next = await call('microsoft_upload_offline_conversion_adjustments', adjustmentArgs), adjustment = mount(next);expect(adjustment.textContent).toContain('Adjust offline conversions');expect(adjustment.textContent).toContain('Restatements');expect(adjustment.querySelector('[data-approve]')).toBeNull();expect(JSON.stringify(next)).not.toContain(offlineEvent.microsoft_click_id);
      const accepted = await call('microsoft_upload_offline_conversion_adjustments', { ...adjustmentArgs, pending_operation_id: (next.structuredContent as any).pending_operation_id });expect(mount(accepted).textContent).toContain('Processing pending');expect(f.writes()).toHaveLength(2);expect(f.writes()[1]!.body.OfflineConversionAdjustments[0].ConversionTime).toBe(offlineEvent.conversion_time);expect(f.state).toEqual(before);expect(callTool).not.toHaveBeenCalled();
    } finally { time.mockRestore();doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  }, 25_000);
});
