import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { additionalAccountIds, AdportError, AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { tiktokTools } from '../../tiktok/src/tools.js';
import { audienceSharingFixture, SHARING_RECIPIENT } from '../../tiktok/test/audience-sharing-fixture.js';
import { CUSTOM_ACCOUNT } from '../../tiktok/test/custom-audience-fixture.js';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Actual SDK/shared policy, simulated native responses and host bridges.
// This is not a positive native write or actual Claude/ChatGPT web-host test.
describe('TikTok audience sharing SDK/widgets', () => {
  it.each(['openai', 'mcp'] as const)('reviews recipient access and revocation through %s without exposing other recipients', async bridge => {
    const f = audienceSharingFixture(), dir = await mkdtemp(join(tmpdir(), 'tiktok-sharing-widget-')), project = 'b310e750-d001-4427-8184-09bd05920e01';f.sharing.shares.push({ ...f.nativeShare('999'), shared_advertiser_name: 'PRIVATE unrelated account' });
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider) }], authorizeToolCall(tool, input) { const allowed = new Set([CUSTOM_ACCOUNT, SHARING_RECIPIENT]);if (typeof input.account_id === 'string' && !allowed.has(input.account_id) || additionalAccountIds(tool, input).some(id => !allowed.has(id))) throw new AdportError('POLICY_VIOLATION', 'Account is outside this synthetic project'); } }), runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', role: 'owner', organization_name: 'QA', providers: ['tiktok'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), client = new Client({ name: 'tiktok-sharing-widget-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);const doms: JSDOM[] = [];
    try {
      const call = async (name: string, args: Record<string, unknown>) => { const result = await client.callTool({ name, arguments: { project_id: project, ...args } });expect(result.isError, JSON.stringify(result)).not.toBe(true);return result; }, callTool = vi.fn((name: string, args: Record<string, unknown>) => call(name, args));
      const mount = (result: unknown) => { const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!; };
      const approve = async (view: Element, count: number) => { expect(f.writes()).toHaveLength(count);const button = view.querySelector('[data-approve]')!;expect(button).not.toBeNull();button.dispatchEvent(new view.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(view.querySelector('.operation-status')?.textContent).toBe(count === 0 ? 'Applied with warnings' : 'Applied'), { timeout: 3000 });expect(f.writes()).toHaveLength(count + 1); };
      const descriptors = (await client.listTools()).tools;for (const name of ['tiktok_custom_audience_shares', 'tiktok_audience_sharing_context', 'tiktok_share_custom_audiences', 'tiktok_unshare_custom_audience']) expect(descriptors.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      const before = f.calls.length, denied = await client.callTool({ name: 'tiktok_audience_sharing_context', arguments: { project_id: project, ...f.selection, shared_advertiser_ids: ['333'] } });expect(denied.isError).toBe(true);expect(f.calls).toHaveLength(before);
      const contextResult = await call('tiktok_audience_sharing_context', f.selection), context = mount(contextResult);expect(context.textContent).toContain('Synthetic <QA audience>');expect(context.textContent).not.toContain('PRIVATE');expect(context.querySelector('script')).toBeNull();
      const share = mount(await call('tiktok_share_custom_audiences', { ...f.selection, expected_context_hash: (contextResult.structuredContent as any).context_hash, acknowledge_recipient_access: true }));expect(share.textContent).toContain('Share custom audiences');expect(share.textContent).toContain('Recipient account');expect(share.textContent).toContain('Grant selected recipients access');expect(share.textContent).not.toContain('PRIVATE');await approve(share, 0);
      const read = mount(await call('tiktok_custom_audience_shares', f.readInput));expect(read.textContent).toContain('PROCESSING');expect(read.textContent).not.toContain('PRIVATE');expect(read.textContent).not.toContain('private hashed');
      const revokeContext = await call('tiktok_audience_sharing_context', { ...f.selection, action: 'UNSHARE' }), nativeInput = await f.unshareInput(), revoke = mount(await call('tiktok_unshare_custom_audience', { ...nativeInput, expected_context_hash: (revokeContext.structuredContent as any).context_hash }));expect(revoke.textContent).toContain('Revoke audience sharing');expect(revoke.textContent).toContain('Revoke selected recipient access');await approve(revoke, 1);
      expect(f.sharing.shares.map(row => row.shared_advertiser_id)).toEqual(['999']);expect(f.state.rows).toHaveLength(1);expect(f.writes().map(call => call.url.pathname)).toEqual(['/open_api/v1.3/dmp/custom_audience/share/', '/open_api/v1.3/dmp/custom_audience/share/cancel/']);
    } finally { doms.forEach(dom => dom.window.close());await client.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  }, 25_000);
});
