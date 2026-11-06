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

describe('X measurement SDK and widget contract', () => {
  it('renders inert pixel data, preserves scoped paging and reviews exact tracking changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adport-x-measurement-widget-')), account = 'a1', project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0', calls: Array<{ url: URL; method: string }> = [];
    const source = { id: 't1', line_item_id: 'l1', tracking_tag_url: 'https://tracker.example.test/old', tracking_tag_type: 'IMPRESSION_TAG', deleted: false };
    const line = { id: 'l1', name: 'QA <ad group>', campaign_id: 'c1', currency: 'EUR', entity_status: 'ACTIVE', deleted: false, placements: ['ALL_ON_TWITTER'], product_type: 'PROMOTED_TWEETS', objective: 'WEBSITE_CLICKS' };
    const campaign = { id: 'c1', name: 'QA', currency: 'EUR', entity_status: 'PAUSED', deleted: false, funding_instrument_id: 'f1', budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 1000000, total_budget_amount_local_micro: null };
    const embed = '<script>globalThis.pixelExecuted=true</script>';
    const provider = new XAdsProvider(new XAdsClient({ consumerKey: 'inert', consumerSecret: 'inert', accessToken: 'inert', accessTokenSecret: 'inert' }, async (input, init = {}) => {
      const url = new URL(String(input));calls.push({ url, method: String(init.method) });if (init.method !== 'GET') throw new Error('Widget test must not mutate');
      const route = url.pathname.replace('/12/accounts/a1', '');
      if (url.pathname === '/12/line_items/placements') return Response.json({ data: [{ product_type: 'PROMOTED_TWEETS', placements: [['ALL_ON_TWITTER']] }] });
      if (url.pathname === '/12/stats/accounts/a1') {
        const params = Object.fromEntries(url.searchParams);return Response.json({ data_type: 'stats', time_series_length: 1, request: { params: { ...params, entity_ids: params.entity_ids!.split(','), metric_groups: params.metric_groups!.split(',') } }, data: [{ id: 'c1', id_data: [{ segment: null, metrics: { conversion_purchases: { metric: [2], order_quantity: [7] } } }] }] });
      }
      if (route === '') return Response.json({ data: { id: account, name: 'QA', approval_status: 'ACCEPTED', timezone: 'UTC', deleted: false } });
      if (route === '/line_items/l1') return Response.json({ data: line });
      if (route === '/campaigns/c1') return Response.json({ data: campaign });
      if (route === '/line_items') return Response.json({ data: [line], next_cursor: null });
      if (route === '/campaigns') return Response.json({ data: [campaign], next_cursor: null });
      if (route === '/tracking_tags/t1') return Response.json({ data: source });
      if (route === '/tracking_tags') return Response.json(url.searchParams.has('cursor') ? { data: [{ ...source, id: 't2', tracking_tag_type: 'CLICK_TRACKER' }], next_cursor: null } : { data: [source], next_cursor: 'next', total_count: 2 });
      if (route === '/web_event_tags/web1') return Response.json({ data: { id: 'web1', name: 'QA <pixel>', type: 'PURCHASE', deleted: false, embed_code: embed } });
      throw new Error('Unexpected resource');
    }));
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: xTools(provider) }] });
    const runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['x'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'x-measurement-widget-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const tools = (await host.listTools()).tools;
      for (const name of ['x_web_event_tags', 'x_app_event_tags', 'x_tracking_tags', 'x_conversion_stats']) { expect(tools.find(tool => tool.name === name)?.outputSchema).toMatchObject({ type: 'object', properties: { records: { type: 'array' } } });expect(tools.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI); }
      expect(tools.find(tool => tool.name === 'x_create_tracking_tag')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });expect(tools.find(tool => tool.name === 'x_delete_tracking_tag')?.annotations?.destructiveHint).toBe(true);
      const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => host.callTool({ name, arguments: args }));
      const mount = (result: unknown) => {
        const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test/' });doms.push(dom);Object.defineProperty(dom.window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } });
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!;
      };
      const pixel = mount(await host.callTool({ name: 'x_get_web_event_tag', arguments: { project_id: project, account_id: account, web_event_tag_id: 'web1' } }));expect(pixel.textContent).toContain(embed);expect(pixel.querySelector('script')).toBeNull();expect(Reflect.get(pixel.ownerDocument.defaultView!, 'pixelExecuted')).toBeUndefined();expect(pixel.querySelector('pixel')).toBeNull();
      expect(tools.find(tool => tool.name === 'x_create_line_item')?.inputSchema.properties).toHaveProperty('primary_web_event_tag');expect(tools.find(tool => tool.name === 'x_create_line_item')?.inputSchema.properties).toHaveProperty('expected_web_event_tag_hash');
      const primary = (await provider.measurement.getWeb({ account_id: account, web_event_tag_id: 'web1' })).data, created = await host.callTool({ name: 'x_create_line_item', arguments: { project_id: project, account_id: account, campaign_id: 'c1', name: 'QA conversion group', objective: 'WEBSITE_CLICKS', product_type: 'PROMOTED_TWEETS', placements: ['ALL_ON_TWITTER'], start_time: '2030-01-01T00:00:00Z', end_time: '2030-01-02T00:00:00Z', goal: 'WEBSITE_CONVERSIONS', primary_web_event_tag: 'web1', expected_web_event_tag_hash: primary.configuration_hash, status: 'ACTIVE', daily_budget_micros: 10_000_001 } }), createReview = mount(created);
      expect(created.isError).not.toBe(true);expect(createReview.textContent).toContain('QA <pixel> · web1');expect(createReview.textContent).toContain('WEBSITE_CONVERSIONS');expect(createReview.textContent).toContain('PAUSED');expect(createReview.querySelector('.review-money')?.textContent).toContain('10.000001');expect(createReview.textContent).toContain('Daily budget');expect(createReview.querySelector('pixel')).toBeNull();expect(createReview.querySelector('[data-approve]')?.textContent).toBe('Hold to apply');
      const createdMeta = (created.structuredContent as { _adport: { approval: { arguments: Record<string, unknown> } } })._adport;expect(createdMeta.approval.arguments).toMatchObject({ project_id: project, account_id: account, primary_web_event_tag: 'web1', expected_web_event_tag_hash: primary.configuration_hash, goal: 'WEBSITE_CONVERSIONS' });
      const args = { project_id: project, account_id: account, count: 1, with_deleted: false, with_total_count: true, line_item_ids: ['l1'] }, initial = await host.callTool({ name: 'x_tracking_tags', arguments: args }), main = mount(initial), list = main.querySelector<HTMLElement>('[data-record-list]')!, first = list.firstElementChild;list.scrollTop = 14;
      expect(main.textContent).toContain('Impression tracker');main.querySelector<HTMLButtonElement>('[data-record-more]')!.click();await vi.waitFor(() => expect(main.textContent).toContain('Click tracker'));expect(list.firstElementChild).toBe(first);expect(list.scrollTop).toBe(14);expect(main.querySelectorAll('article')).toHaveLength(2);expect(callTool).toHaveBeenCalledWith('x_tracking_tags', { ...args, cursor: 'next' });expect(calls.find(call => call.url.searchParams.has('cursor'))!.url.searchParams.has('with_total_count')).toBe(false);
      const current = (await provider.measurement.getTracking({ account_id: account, tracking_tag_id: 't1' })).data, preview = await host.callTool({ name: 'x_update_tracking_tag', arguments: { project_id: project, account_id: account, tracking_tag_id: 't1', expected_configuration_hash: current.configuration_hash, tracking_tag_url: 'https://tracker.example.test/approved' } }), review = mount(preview);
      expect(preview.isError).not.toBe(true);expect(review.querySelector('.review-before')?.textContent).toBe(source.tracking_tag_url);expect(Array.from(review.querySelectorAll('.review-after'), value => value.textContent)).toContain('https://tracker.example.test/approved');expect(review.querySelector('[data-approve]')?.textContent).toBe('Hold to apply');
      const date = new Date().toISOString().slice(0, 10), conversions = await host.callTool({ name: 'x_conversion_stats', arguments: { project_id: project, account_id: account, entity: 'CAMPAIGN', entity_ids: ['c1'], start_date: date, end_date: date, placement: 'TREND', metric_group: 'WEB_CONVERSION' } });expect(conversions.isError).not.toBe(true);expect(conversions.structuredContent).toHaveProperty('normalized', false);const report = mount(conversions);expect(report.textContent).toContain('TREND');expect(report.textContent).toContain('order_quantity');expect(report.querySelector('[data-approve]')).toBeNull();expect(calls.every(call => call.method === 'GET')).toBe(true);
    } finally { for (const dom of doms) dom.window.close();await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  });
});
