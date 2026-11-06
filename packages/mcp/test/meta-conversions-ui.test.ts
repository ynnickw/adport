import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { MetaAdsProvider, MetaGraphClient, metaTools } from '@adport/provider-meta';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

describe('Meta custom-conversion SDK/widget contracts', () => {
  it.each(['openai', 'mcp'] as const)('preserves record nodes/scroll and renders guarded review/receipt through %s', async bridge => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-meta-conversions-widget-'));
    const account = '1234', project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0', conversionId = '701';
    const conversion = { id: conversionId, account_id: account, name: 'Registration <script>globalThis.executed=true</script>', description: 'Original', rule: '{"url":{"i_contains":"/thanks"}}', custom_event_type: 'COMPLETE_REGISTRATION', default_conversion_value: 100, pixel: { id: '901', name: 'Pixel' }, action_source_type: 'website', event_source_type: 'PIXEL', is_archived: false, is_unavailable: false };
    let writes = 0;
    const provider = new MetaAdsProvider(new MetaGraphClient({ accessToken: 'inert' }, 'v25.0', async (raw, init = {}) => {
      const url = new URL(String(raw));
      if (url.pathname.endsWith('/customconversions')) return Response.json(url.searchParams.has('after') ? { data: [{ ...conversion, id: '702', name: 'Second conversion' }] } : { data: [conversion], paging: { next: `https://graph.facebook.com/v25.0/act_${account}/customconversions?after=next-one&access_token=NEVER-REPLAY` } });
      if (url.pathname === `/v25.0/${conversionId}`) {
        if (init.method === 'POST') { writes++;conversion.description = new URLSearchParams(String(init.body)).get('description')!;return Response.json({ success: true }); }
        return Response.json(conversion);
      }
      throw new Error('Unexpected fixture endpoint');
    }));
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: metaTools(provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['meta'] }], resolve: async value => { expect(value).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'meta-conversion-widget', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => host.callTool({ name, arguments: args }));
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test/', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
      };
      const definitions = (await host.listTools()).tools;
      for (const name of ['meta_list_custom_conversions', 'meta_get_custom_conversion', 'meta_custom_conversion_stats', 'meta_custom_conversion_usage', 'meta_create_custom_conversion', 'meta_update_custom_conversion', 'meta_delete_custom_conversion']) expect(definitions.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      const args = { project_id: project, account_id: account };
      const first = await host.callTool({ name: 'meta_list_custom_conversions', arguments: { ...args, limit: 1 } });expect(first.isError).not.toBe(true);
      const main = mount(first), list = main.querySelector<HTMLElement>('[data-record-list]')!, node = list.querySelector('article')!;list.scrollTop = 20;
      expect(main.textContent).toContain('Registration <script>');expect(Reflect.get(main.ownerDocument.defaultView!, 'executed')).toBeUndefined();
      main.querySelector<HTMLButtonElement>('[data-record-more]')!.click();await vi.waitFor(() => expect(main.textContent).toContain('Second conversion'));
      expect(list.querySelector('article')).toBe(node);expect(list.scrollTop).toBe(20);
      expect(callTool).toHaveBeenCalledWith('meta_list_custom_conversions', { ...args, limit: 1, cursor: 'next-one' });
      const current = await host.callTool({ name: 'meta_get_custom_conversion', arguments: { ...args, conversion_id: conversionId } });expect(current.isError).not.toBe(true);
      const input = { ...args, conversion_id: conversionId, expected_snapshot_hash: (current.structuredContent as any).snapshot_hash, acknowledge_shared_effects: true, description: 'Edited by agent' };
      const preview = await host.callTool({ name: 'meta_update_custom_conversion', arguments: input });expect(preview.isError).not.toBe(true);
      const review = mount(preview);expect(review.textContent).toContain('Edit custom conversion');expect(review.textContent).toContain('Original');expect(review.textContent).toContain('Edited by agent');expect(review.textContent).toContain('other accounts');expect(review.querySelector('[data-approve]')).not.toBeNull();expect(writes).toBe(0);
      const pending = (preview.structuredContent as any).pending_operation_id;
      const applied = await host.callTool({ name: 'meta_update_custom_conversion', arguments: { ...input, pending_operation_id: pending } });expect(applied.isError).not.toBe(true);expect(writes).toBe(1);
      const receipt = mount(applied);expect(receipt.textContent).toContain('Applied');expect(receipt.textContent).toContain('Edited by agent');
      expect(JSON.stringify({ first, preview, applied })).not.toContain('NEVER-REPLAY');
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  });
});
