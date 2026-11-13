import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, withProjectRouting } from '@adport/core';
import { GoogleAdsProvider, GoogleAdsRestClient, googleTools } from '@adport/provider-google';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, ADPORT_UI_URI } from '../src/ui.js';

// Synthetic bridges exercise actual shared schemas/SDK/policy; no actual native host claim.
describe('Google targeting native reviews and SDK/widget paging', () => {
  it.each(['openai', 'mcp'] as const)('keeps scoped records stable and reviews exact targeting changes through %s', async bridge => {
    const dir = await mkdtemp(join(tmpdir(), 'google-targeting-widget-')), project = 'b310e750-d001-4427-8184-09bd05920e01', account = '1234567890', root = `customers/${account}`, campaignId = '42';
    const state: Record<string, any> = { customer: { resourceName: root, id: account, currencyCode: 'EUR', timeZone: 'Europe/Berlin' }, campaign: { resourceName: `${root}/campaigns/42`, id: campaignId, name: 'Synthetic Search campaign', status: 'PAUSED', advertisingChannelType: 'SEARCH', biddingStrategyType: 'MANUAL_CPC', campaignBudget: `${root}/campaignBudgets/24`, geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE_OR_INTEREST', negativeGeoTargetType: 'PRESENCE' } }, budget: { resourceName: `${root}/campaignBudgets/24`, amountMicros: '3000000', period: 'DAILY', explicitlyShared: false }, criteria: [{ resourceName: `${root}/campaignCriteria/42~201`, campaign: `${root}/campaigns/42`, criterionId: '201', type: 'LOCATION', status: 'ENABLED', negative: false, location: { geoTargetConstant: 'geoTargetConstants/2840' } }, { resourceName: `${root}/campaignCriteria/42~202`, campaign: `${root}/campaigns/42`, criterionId: '202', type: 'LOCATION', status: 'ENABLED', negative: true, location: { geoTargetConstant: 'geoTargetConstants/2276' } }, { resourceName: `${root}/campaignCriteria/42~30001`, campaign: `${root}/campaigns/42`, criterionId: '30001', type: 'DEVICE', status: 'ENABLED', negative: false, device: { type: 'MOBILE' } }] };
    const mutations: any[] = [];let nextId = 900;
    const provider = new GoogleAdsProvider(new GoogleAdsRestClient({ clientId: 'inert', clientSecret: 'inert', refreshToken: 'inert' }, 'v25', async (raw, init = {}) => {
      const url = new URL(String(raw)), body = url.hostname === 'oauth2.googleapis.com' ? {} : JSON.parse(String(init.body ?? '{}'));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'inert', expires_in: 3600 });
      if (url.pathname.endsWith('googleAds:search')) {
        const query = body.query;
        if (query.includes(' FROM customer ')) return Response.json({ results: [{ customer: state.customer }] });
        if (query.includes(' FROM campaign ')) return Response.json({ results: [{ campaign: state.campaign, campaignBudget: state.budget }] });
        if (query.includes(' FROM campaign_criterion ')) return Response.json({ results: state.criteria.map((row: any) => ({ campaign: { id: campaignId }, campaignCriterion: row })) });
        if (query.includes(' FROM geo_target_constant ')) return Response.json({ results: query.match(/\.id IN \(([^)]+)\)/)[1].split(',').map((id: string) => ({ geoTargetConstant: { resourceName: `geoTargetConstants/${id}`, id, name: `<Native location ${id}>`, status: 'ENABLED' } })) });
        throw new Error('Unexpected synthetic GAQL query');
      }
      expect(url.pathname).toBe(`/v25/customers/${account}/googleAds:mutate`);expect(body.partialFailure).toBe(false);mutations.push(body);
      if (body.validateOnly) return Response.json({});
      const responses = body.mutateOperations.map((row: any) => {
        if (row.campaignOperation) { state.campaign.geoTargetTypeSetting = { ...state.campaign.geoTargetTypeSetting, ...row.campaignOperation.update.geoTargetTypeSetting };return { campaignResult: { resourceName: state.campaign.resourceName } }; }
        const op = row.campaignCriterionOperation;
        if (op.remove) { state.criteria = state.criteria.filter((row: any) => row.resourceName !== op.remove);return { campaignCriterionResult: { resourceName: op.remove } }; }
        if (op.update) { const existing = state.criteria.find((row: any) => row.resourceName === op.update.resourceName);expect(op.updateMask).toBe('bid_modifier');existing.bidModifier = Math.fround(op.update.bidModifier);return { campaignCriterionResult: { resourceName: existing.resourceName } }; }
        const id = String(nextId++), created = { resourceName: `${root}/campaignCriteria/42~${id}`, criterionId: id, type: op.create.location ? 'LOCATION' : 'AD_SCHEDULE', ...op.create };state.criteria.push(created);return { campaignCriterionResult: { resourceName: created.resourceName } };
      });return Response.json({ mutateOperationResponses: responses });
    }));
    const base = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider, tools: googleTools(provider) }] }), runtime = withProjectRouting(base, { list: async () => [{ id: project, name: 'Adport', organization_name: 'QA', role: 'owner', providers: ['google'] }], resolve: async id => { expect(id).toBe(project);return base; } });
    const server = createMcpServer({ runtime, catalog: { profile: 'full', providers: null }, scopes: ['tools:read', 'tools:write'] }), host = new Client({ name: 'google-targeting-widget-qa', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);const doms: JSDOM[] = [];
    try {
      const call = async (name: string, args: Record<string, unknown>) => { const result = await host.callTool({ name, arguments: { project_id: project, account_id: account, ...args } });expect(result.isError).not.toBe(true);return result; }, callTool = vi.fn((name: string, args: Record<string, unknown>) => call(name, args));
      const mount = (result: unknown) => { const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) { if (bridge === 'openai') Object.defineProperty(window, 'openai', { value: { callTool, notifyIntrinsicHeight() {} } }); } });doms.push(dom);
        if (bridge === 'mcp') vi.spyOn(dom.window.parent, 'postMessage').mockImplementation(message => { if (message.method === 'tools/call') void callTool(message.params.name, message.params.arguments).then(result => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', id: message.id, result } }))); });dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));return dom.window.document.querySelector('main')!; };
      for (const name of ['google_campaign_targeting', 'google_update_targeting']) expect((await host.listTools()).tools.find(tool => tool.name === name)?._meta?.['openai/outputTemplate']).toBe(ADPORT_UI_URI);
      const first = await call('google_campaign_targeting', { campaign_id: campaignId, page_size: 1 }), list = mount(first), cards = list.querySelector<HTMLElement>('[data-record-list]')!, firstCard = cards.firstElementChild;cards.scrollTop = 37;
      expect(list.textContent).toContain('<Native location 2840>');expect(list.querySelector('native')).toBeNull();list.querySelector<HTMLButtonElement>('[data-record-more]')!.click();list.querySelector<HTMLButtonElement>('[data-record-more]')!.click();await vi.waitFor(() => expect(list.textContent).toContain('<Native location 2276>'));expect(cards.firstElementChild).toBe(firstCard);expect(cards.scrollTop).toBe(37);expect(callTool).toHaveBeenCalledTimes(1);expect(mutations).toEqual([]);
      const args = { campaign_id: campaignId, expected_snapshot_hash: (first.structuredContent as any).snapshot_hash, acknowledge_delivery_effects: true, locations: { include: { add_ids: ['2826'], remove_ids: ['2840'] } }, ad_schedules: [{ day: 'MONDAY', start_hour: 0, start_minute: 0, end_hour: 24, end_minute: 0 }], device_bid_modifiers: [{ device: 'MOBILE', bid_modifier: 0.7 }], positive_geo_target_type: 'PRESENCE' }, preview = await call('google_update_targeting', args), view = mount(preview);
      expect(view.textContent).toContain('Update campaign targeting');expect(view.textContent).toContain('Weekly schedule');expect(view.textContent).toContain('Europe/Berlin');expect(view.textContent).toContain('0.7×');expect(view.textContent).toContain('Not reported');expect(view.textContent).toContain('<Native location 2826>');expect(mutations.map(row => row.validateOnly)).toEqual([true]);
      const approve = view.querySelector<HTMLButtonElement>('[data-approve]')!;expect(approve).not.toBeNull();approve.dispatchEvent(new view.ownerDocument.defaultView!.KeyboardEvent('keydown', { key: ' ', bubbles: true }));await vi.waitFor(() => expect(view.querySelector('.operation-status')?.textContent).toBe('Applied'), { timeout: 3000 });expect(mutations.map(row => row.validateOnly)).toEqual([true, true, false]);expect(callTool).toHaveBeenLastCalledWith('google_update_targeting', expect.objectContaining({ account_id: account, project_id: project, expected_snapshot_hash: args.expected_snapshot_hash, pending_operation_id: expect.any(String) }));
      expect(state.campaign.status).toBe('PAUSED');expect(state.budget.amountMicros).toBe('3000000');expect(state.criteria.find((row: any) => row.criterionId === '202').negative).toBe(true);expect(state.criteria.find((row: any) => row.criterionId === '30001').bidModifier).toBe(Math.fround(0.7));
      const readback = await call('google_campaign_targeting', { campaign_id: campaignId });expect((readback.structuredContent as any).snapshot_hash).not.toBe(args.expected_snapshot_hash);expect((readback.structuredContent as any).criteria.some((row: any) => row.location?.geoTargetConstant === 'geoTargetConstants/2826')).toBe(true);
    } finally { doms.forEach(dom => dom.window.close());await host.close();await server.close();await rm(dir, { recursive: true, force: true }); }
  }, 25_000);
});
