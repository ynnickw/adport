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

// Real SDK/shared registry with synthetic host bridges. Not actual Claude/ChatGPT execution.
describe('X published-post and promotion SDK/widgets', () => {
  it.each(['openai', 'mcp'] as const)('keeps publication, ACTIVE associations and removal distinct through %s', async bridge => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-x-post-widget-')), project = 'b310e750-d001-4427-8184-09bd05920e01', account = 'a1', user = '756201191646691328', id = '1166476031668015104', second = '1166476031668015105', created = '1166476031668015199';
    const post = { id_str: id, user: { id_str: user }, name: 'First published post', full_text: '<Actual native copy>', nullcast: true, tweet_type: 'PUBLISHED', conversation_settings: 'EVERYONE', truncated: false, extended_entities: { media: [{ id_str: second, type: 'video', media_url_https: 'https://pbs.twimg.com/qa.jpg', video_info: { variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com/qa.mp4' }] } }] } };
    const posts = [post, { ...post, id_str: second, name: 'Second published post' }], associations: Array<{ id: string; tweet_id: string; line_item_id: string; entity_status: string; deleted: boolean }> = [], mutations: Array<{ method: string; path: string }> = [];
    const provider = new XAdsProvider(new XAdsClient({ consumerKey: 'inert', consumerSecret: 'inert', accessToken: 'inert', accessTokenSecret: 'inert' }, async (raw, init = {}) => {
      const url = new URL(String(raw)), path = url.pathname.replace('/12/accounts/a1', ''), q = url.searchParams, ok = (data: unknown) => Response.json({ data });
      if (init.method === 'GET') {
        if (path === '') return ok({ id: account, name: 'QA', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false });
        if (path === '/promotable_users') return Response.json({ data: [{ id: 'u1', user_id: user, promotable_user_type: 'FULL', deleted: false }], next_cursor: null });
        if (path === '/authenticated_user_access') return ok({ user_id: user, permissions: [] });
        if (path === '/campaigns/c1') return ok({ id: 'c1', name: 'QA campaign', currency: 'USD', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_000, total_budget_amount_local_micro: null });
        if (path === '/line_items/l1') return ok({ id: 'l1', name: 'QA ad group', campaign_id: 'c1', currency: 'USD', entity_status: 'PAUSED', deleted: false, placements: ['ALL_ON_TWITTER'], product_type: 'PROMOTED_TWEETS', objective: 'ENGAGEMENTS' });
        if (path === '/tweets') {
          if (q.has('tweet_ids')) return Response.json({ data: posts.filter(row => q.get('tweet_ids')!.split(',').includes(row.id_str)), next_cursor: null });
          const start = q.has('cursor') ? 1 : 0, count = Number(q.get('count') ?? 20);return Response.json({ data: posts.slice(start, start + count), next_cursor: start + count < posts.length ? 'page-two' : null });
        }
        if (path === '/promoted_tweets') return Response.json({ data: associations.filter(row => q.get('with_deleted') === 'true' || !row.deleted), next_cursor: null });
        if (path === '/promoted_tweets/pt1') return ok(associations[0]);
      }
      mutations.push({ method: init.method!, path });
      if (path === `/tweets/${id}/name` && init.method === 'PUT') { posts[0]!.name = q.get('name')!;return ok(posts[0]); }
      if (path === '/tweet' && init.method === 'POST') { posts.push({ ...post, id_str: created, name: q.get('name')!, full_text: q.get('text')! });return ok({ id_str: created, user: { id_str: user } }); }
      if (path === '/promoted_tweets' && init.method === 'POST') { expect(q.get('line_item_id')).toBe('l1');expect(q.get('tweet_ids')).toBe(created);associations.push({ id: 'pt1', tweet_id: created, line_item_id: 'l1', entity_status: 'ACTIVE', deleted: false });return ok(associations); }
      if (path === '/promoted_tweets/pt1' && init.method === 'DELETE') { associations[0]!.deleted = true;return ok(associations[0]); }
      throw new Error(`Unexpected synthetic endpoint ${init.method} ${path}`);
    }));
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: xTools(provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['x'] }], resolve: async value => { expect(value).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'x-post-widget-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const call = async (name: string, args: Record<string, unknown>) => { const result = await host.callTool({ name, arguments: { project_id: project, account_id: account, ...args } });expect(result.isError).not.toBe(true);return result; };
      const callTool = vi.fn((name: string, args: Record<string, unknown>) => call(name, args));
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
      };
      const applyView = async (view: Element, before: number) => { expect(mutations).toHaveLength(before);const button = view.querySelector('[data-approve]')!;expect(button).not.toBeNull();button.dispatchEvent(new view.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(view.querySelector('.operation-status')?.textContent).toBe('Applied'), { timeout: 3000 });expect(mutations).toHaveLength(before + 1); };
      const descriptors = (await host.listTools()).tools;
      for (const name of ['x_published_posts', 'x_promoted_posts', 'x_create_promoted_only_post', 'x_rename_published_post', 'x_create_promoted_posts', 'x_delete_promoted_post']) expect(descriptors.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      const gallery = mount(await call('x_published_posts', { user_id: user, count: 1 })), grid = gallery.querySelector<HTMLElement>('[data-provider-gallery]')!, player = gallery.querySelector('video')!;grid.scrollTop = 47;player.currentTime = 8;
      expect(gallery.querySelector('script')).toBeNull();expect(gallery.textContent).toContain(post.full_text);
      gallery.querySelector<HTMLButtonElement>('[data-provider-more]')!.click();gallery.querySelector<HTMLButtonElement>('[data-provider-more]')!.click();await vi.waitFor(() => expect(gallery.querySelectorAll('article')).toHaveLength(2));expect(gallery.querySelector('video')).toBe(player);expect(player.currentTime).toBe(8);expect(grid.scrollTop).toBe(47);expect(callTool).toHaveBeenCalledTimes(1);
      gallery.querySelector<HTMLButtonElement>('[data-creative-action]')!.click();gallery.querySelector<HTMLInputElement>('[data-field="0"]')!.value = 'Renamed by widget';gallery.querySelector('form')!.dispatchEvent(new gallery.ownerDocument.defaultView!.Event('submit', { bubbles: true, cancelable: true }));await vi.waitFor(() => expect(gallery.querySelector('[data-approve]')).not.toBeNull());expect(gallery.textContent).toContain('Rename published post');await applyView(gallery, 0);expect(posts[0]!.name).toBe('Renamed by widget');expect(posts[0]!.full_text).toBe(post.full_text);
      const fields = { as_user_id: user, text: 'Promoted-only QA copy', name: 'New native post' }, context = await call('x_post_creation_context', fields), publication = mount(await call('x_create_promoted_only_post', { ...fields, expected_context_hash: (context.structuredContent as any).context_hash, confirm_publication: true }));
      expect(publication.textContent).toContain('PUBLISHED · promoted-only · no ad association');await applyView(publication, 1);expect(associations).toHaveLength(0);
      const selection = { line_item_id: 'l1', user_id: user, tweet_ids: [created] }, promotionContext = await call('x_promotion_context', selection), promotion = mount(await call('x_create_promoted_posts', { ...selection, expected_context_hash: (promotionContext.structuredContent as any).context_hash, acknowledge_active_associations: true }));
      expect(promotion.textContent).toContain('Native association status');expect(promotion.textContent).toContain('ACTIVE');expect(promotion.textContent).toContain('PAUSED');await applyView(promotion, 2);
      const promoted = mount(await call('x_promoted_posts', { line_item_id: 'l1', user_id: user }));expect(promoted.textContent).toContain('Promoted-only QA copy');promoted.querySelector<HTMLButtonElement>('[data-creative-action]')!.click();await vi.waitFor(() => expect(promoted.querySelector('[data-approve]')).not.toBeNull());expect(promoted.textContent).toContain('Remove post from ad group');expect(promoted.textContent).toContain('not post deletion');await applyView(promoted, 3);
      expect(posts.some(row => row.id_str === created)).toBe(true);expect(associations[0]).toMatchObject({ deleted: true, entity_status: 'ACTIVE' });expect(mutations).toEqual([{ method: 'PUT', path: `/tweets/${id}/name` }, { method: 'POST', path: '/tweet' }, { method: 'POST', path: '/promoted_tweets' }, { method: 'DELETE', path: '/promoted_tweets/pt1' }]);
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  }, 25_000);
});
