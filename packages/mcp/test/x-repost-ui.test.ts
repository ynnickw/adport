import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AdportError, AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { xTools } from '../../x/src/tools.js';
import { repostFixture, REPOST_ACCOUNT, REPOST_ID, REPOST_RECEIVER } from '../../x/test/repost-fixture.js';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Actual MCP SDK/policy/widget with simulated native endpoints and host bridges.
// This does not verify real Claude/ChatGPT execution or native copy promotion.
describe('X repost SDK/widget operations', () => {
  it.each(['openai', 'mcp'] as const)('reviews originals, creates mapped copies and retains copied-gallery nodes through %s', async bridge => {
    const f = repostFixture(2);f.state.sources[0]!.extended_entities = { media: [{ id_str: REPOST_ID, type: 'photo', media_url_https: 'https://pbs.twimg.com/qa.jpg' }] };
    await widgetFixture(f, bridge, async ({ call, mount, approve, facts }) => {
      const context = await call('x_repost_promotion_context', f.selection()), sources = mount(context);expect(sources.querySelectorAll('article')).toHaveLength(2);expect(sources.querySelector('[data-creative-action]')).toBeNull();expect(sources.textContent).toContain(f.state.sources[0]!.full_text);expect(sources.querySelector('script')).toBeNull();
      const review = mount(await call('x_create_repost_promotions', { ...f.selection(), expected_context_hash: (context.structuredContent as any).context_hash, acknowledge_active_associations: true, acknowledge_new_published_copies: true }));expect(review.textContent).toContain('Create promoted repost copies');expect(review.textContent).toContain('PAUSED');expect(review.textContent).toContain('ACTIVE');await approve(review, 'Applied with warnings');expect(f.mutations()).toHaveLength(2);expect(f.state.copies).toHaveLength(2);
      await vi.waitFor(() => expect(facts().at(-1)?.reconciliation.source_copy_mappings).toHaveLength(2));expect(facts().at(-1)?.reconciliation.next_arguments).toEqual({ project_id: 'b310e750-d001-4427-8184-09bd05920e01', account_id: REPOST_ACCOUNT, line_item_id: 'l1', user_id: REPOST_RECEIVER });
      const gallery = mount(await call('x_promoted_posts', { line_item_id: 'l1', user_id: REPOST_RECEIVER, count: 1 })), grid = gallery.querySelector<HTMLElement>('[data-provider-gallery]')!, image = gallery.querySelector('img');grid.scrollTop = 37;gallery.querySelector<HTMLButtonElement>('[data-provider-more]')!.click();gallery.querySelector<HTMLButtonElement>('[data-provider-more]')!.click();await vi.waitFor(() => expect(gallery.querySelectorAll('article')).toHaveLength(2));expect(gallery.querySelector('img')).toBe(image);expect(grid.scrollTop).toBe(37);
      gallery.querySelector<HTMLButtonElement>('[data-creative-action]')!.click();await vi.waitFor(() => expect(gallery.querySelector('[data-approve]')).not.toBeNull());await approve(gallery, 'Applied');expect(f.mutations()).toHaveLength(3);expect(f.state.sources).toHaveLength(2);expect(f.state.copies).toHaveLength(2);expect(f.state.associations.filter(row => row.deleted)).toHaveLength(1);
    });
  }, 25_000);
  it.each(['openai', 'mcp'] as const)('retains partial source/copy receipts in the widget and model context through %s', async bridge => {
    const f = repostFixture(2);f.state.hook = async call => { if (call.init.method === 'POST' && call.url.searchParams.get('tweet_ids') === REPOST_ID) { await new Promise(resolve => setTimeout(resolve, 20));return new Response('PRIVATE native body', { status: 500 }); }return undefined; };
    const apply = f.provider.applyWrite.bind(f.provider);
    vi.spyOn(f.provider, 'applyWrite').mockImplementation(async (...args) => {
      try { return await apply(...args); } catch (error) {
        if (!(error instanceof AdportError)) throw error;
        const details = error.details as Record<string, any>;
        // Exercise the widget's allowlist independently of provider redaction.
        throw new AdportError(error.code, error.message, { ...details, native_body: 'PRIVATE native payload', resource_ids: [...details.resource_ids, 'https://private.example/file?token=PRIVATE'], confirmed_source_copy_mappings: [...details.confirmed_source_copy_mappings.map((row: object) => ({ ...row, private_field: 'PRIVATE' })), { source_tweet_id: '999', copied_tweet_id: '998', promoted_tweet_id: 'unselectedprivate' }], source_outcomes: [...details.source_outcomes, { source_tweet_id: '999', state: 'UNCONFIRMED' }], unattempted_source_ids: ['999'] });
      }
    });
    await widgetFixture(f, bridge, async ({ call, mount, approve, facts }) => {
      const context = await call('x_repost_promotion_context', f.selection()), review = mount(await call('x_create_repost_promotions', { ...f.selection(), expected_context_hash: (context.structuredContent as any).context_hash, acknowledge_active_associations: true, acknowledge_new_published_copies: true }));await approve(review, 'Unconfirmed');expect(f.mutations()).toHaveLength(2);expect(f.state.copies).toHaveLength(1);
      await vi.waitFor(() => expect(facts().at(-1)?.status).toBe('unconfirmed'));const outcome = facts().at(-1)!;expect(outcome.reconciliation.confirmed_source_copy_mappings).toEqual([{ source_tweet_id: f.state.sources[1]!.id_str, copied_tweet_id: f.state.copies[0]!.id_str, promoted_tweet_id: f.state.associations[0]!.id }]);expect(outcome.resource_ids).toEqual([f.state.associations[0]!.id]);expect(outcome.reconciliation.source_outcomes).toEqual([{ source_tweet_id: REPOST_ID, state: 'UNCONFIRMED' }]);expect(outcome.reconciliation).not.toHaveProperty('unattempted_source_ids');expect(review.textContent).toContain(f.state.associations[0]!.id);expect(review.textContent).not.toMatch(/PRIVATE|unselectedprivate/);expect(JSON.stringify(outcome)).not.toMatch(/PRIVATE|unselectedprivate|pending_operation_id/);expect(review.querySelector('[data-approve]')).toBeNull();
    });
  }, 25_000);
});

async function widgetFixture(f: ReturnType<typeof repostFixture>, bridge: 'openai' | 'mcp', run: (helpers: { call(name: string, args: Record<string, unknown>): Promise<any>; mount(result: unknown): Element; approve(view: Element, phase: string): Promise<void>; facts(): Record<string, any>[] }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'x-repost-widget-')), project = 'b310e750-d001-4427-8184-09bd05920e01', notifications: Record<string, any>[] = [];
  const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: xTools(f.provider) }] }), runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['x'] }], resolve: async id => { expect(id).toBe(project);return base; } });
  const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), client = new Client({ name: 'x-repost-widget-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);const doms: JSDOM[] = [];
  try {
    const call = async (name: string, args: Record<string, unknown>) => { const result = await client.callTool({ name, arguments: { project_id: project, account_id: REPOST_ACCOUNT, ...args } });expect(result.isError, JSON.stringify(result)).not.toBe(true);return result; }, callTool = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const mount = (result: unknown) => { const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {}, setWidgetState(value: any) { notifications.push(value.lastOperation); } } }); } });doms.push(dom);
      if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } })));if (message.method === 'ui/update-model-context' && message.params.structuredContent?.adport_operation) notifications.push(message.params.structuredContent.adport_operation); });
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!; };
    const descriptors = (await client.listTools()).tools;for (const name of ['x_repost_promotion_context', 'x_create_repost_promotions']) expect(descriptors.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
    const approve = async (view: Element, phase: string) => { const before = f.mutations().length, button = view.querySelector('[data-approve]')!;expect(button).not.toBeNull();button.dispatchEvent(new view.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(view.querySelector('.operation-status')?.textContent).toBe(phase), { timeout: 4000 });expect(f.mutations().length).toBeGreaterThan(before); };
    await run({ call, mount, approve, facts: () => notifications });
  } finally { doms.forEach(dom => dom.window.close());await client.close();await server.close();await rm(dir, { recursive: true, force: true }); }
}
