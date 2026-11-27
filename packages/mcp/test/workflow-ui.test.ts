import { createContext, defineTool, MockProvider, type AdProvider, gscTools, withProjectRouting } from '@adport/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_HTML, structuredResult, type AdportView } from '../src/ui.js';

const project = { project_id: 'project' };
const asset = { id: 'media-id', sha256: 'a'.repeat(64), name: 'App icon' };
const argumentsForUpload = { account_id: 'account', media_id: asset.id, expected_sha256: asset.sha256, name: asset.name };
const upload = { provider: 'google', account_id: 'account', account_name: 'Search', ready: true, available: true, stage: 'upload', tool: 'google_upload_image_asset', arguments: argumentsForUpload };

function setup(callTool = vi.fn()) {
  const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', beforeParse(window) {
    Object.defineProperty(window, 'openai', { value: { callTool } });
  } });
  const document = dom.window.document;
  const send = (data: unknown) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: data } },
  }));
  return { document, send, callTool, close: () => dom.window.close() };
}

function mount(tool: string, data: object, provider?: string, view: AdportView = 'data') {
  const fixture = setup();
  fixture.send(structuredResult(tool, view, data, undefined, undefined, undefined, undefined, undefined, provider ? { provider } : undefined));
  return fixture;
}

describe('specialized read widgets', () => {
  it('puts capability matches and blockers on the card and uses the scoped settings link', () => {
    const fixture = mount('capabilities_list', {
      profile: 'full', platforms: [{ id: 'meta', selected: true, connected: false }], total_matches: 2, truncated: true,
      tools: [{ name: 'meta_list_ads', enabled: false, blockers: ['not_connected'], next_steps: ['Connect Meta.'], read_only: true }],
      manage_access_url: 'https://app.adport.dev/dashboard/agents?projectId=abc#connected-assistants',
    });
    try {
      const { document } = fixture;
      expect(document.querySelector('.workflow-item')?.textContent).toContain('meta_list_adsBlocked');
      expect(document.querySelector('.workflow-item')?.textContent).toContain('Connect Meta.');
      expect(document.querySelector('.context')?.textContent).toBe('1 of 2 matching tools');
      expect(document.querySelector('a')?.getAttribute('href')).toContain('/dashboard/agents?projectId=abc');
      expect(fixture.callTool).not.toHaveBeenCalled();
    } finally { fixture.close(); }
  });

  it('preserves absent Reddit event activity, and shows native Pinterest components', () => {
    const reddit = mount('reddit_pixel_last_fired', { pixel_id: 'p1', last_fired_at: { purchase: null, page_visit: '2026-11-02T12:00:00Z' } }, 'reddit');
    const pinterest = mount('pinterest_event_quality', { items: [{ overall_status: 'GOOD', lookback_period: '14d', source_platform: 'WEB',
      ingestion_source: 'CONVERSIONS_API', quality_components: { hashed_email: { checkout: { coverage: 0.9, overlap: 0, issues: [{ name: 'Example issue', reason: 'Missing value' }] } } } }] }, 'pinterest');
    try {
      expect(reddit.document.querySelector('.workflow-table')?.textContent).toContain('PurchaseUnavailable');
      expect(reddit.document.querySelector('.workflow-table')?.textContent).toContain('2026-11-02T12:00:00Z');
      expect(pinterest.document.querySelector('.workflow-item')?.textContent).toContain('14d');
      expect(pinterest.document.querySelector('.workflow-table')?.textContent).toContain('0.90Example issue · Missing value');
    } finally { reddit.close(); pinterest.close(); }
  });

  it('plots native Meta count buckets and retains exact integers and reported zero in its table', () => {
    const fixture = mount('meta_custom_conversion_stats', { conversion_id: 'c1', aggregation: 'count', stats: [
      { timestamp: '2026-11-01T00:00:00+0000', data: [{ value: '12345678901234567890', dimension: 'native' }] },
      { timestamp: '2026-11-02T00:00:00+0000', data: [{ value: '0', dimension: 'native' }] },
    ] }, 'meta');
    try {
      expect(fixture.document.querySelector('[data-native-line] svg')).not.toBeNull();
      expect(fixture.document.querySelector('.workflow-table')?.textContent).toContain('12345678901234567890');
      expect(fixture.document.querySelector('.workflow-table')?.textContent).toContain('Value 0');
    } finally { fixture.close(); }
  });

  it('distinguishes catalog batch completion from failed and missing items', () => {
    const fixture = mount('pinterest_catalog_item_batch_status', { batch_id: 'batch', status: 'COMPLETED', submitted_items: 3, terminal_items: 2,
      all_items_native_successful: false, records: [{ id: 'a', status: 'SUCCESS' }, { id: 'b', status: 'FAILURE' }, { id: 'c', status: 'MISSING' }],
    }, 'pinterest', 'records');
    try {
      expect(fixture.document.querySelector('.receipt-state')?.textContent).toBe('Completed');
      expect(fixture.document.querySelector('main')?.textContent).toContain('unsuccessful or unconfirmed');
      expect([...fixture.document.querySelectorAll('.workflow-item .pill')].map(node => node.textContent)).toEqual(['SUCCESS', 'FAILURE', 'MISSING']);
      expect(fixture.document.querySelector('progress,button')).toBeNull();
    } finally { fixture.close(); }
  });

  it('only exposes the verified report link before it expires', () => {
    const data = { report_available: true, download_url: 'https://report.example.test/archive', records: [{ name: 'Report' }] };
    const current = mount('reddit_catalog_import_report', { ...data, expires_at: '2099-01-01T00:00:00Z' }, 'reddit', 'records');
    const expired = mount('reddit_catalog_import_report', { ...data, expires_at: '2000-01-01T00:00:00Z' }, 'reddit', 'records');
    try {
      expect(current.document.querySelector('a')?.rel).toContain('noreferrer');
      expect(expired.document.querySelector('a')).toBeNull();
    } finally { current.close(); expired.close(); }
  });

  it('shows Apple change history in UTC order and retains reported ID and count fields', () => {
    const fixture = mount('apple_change_history', { result: [
      { transactionId: 'old', eventType: 'UPDATE', entityType: 'Campaign', eventTime: '2026-11-01T01:00:00.000Z', modifiedBy: 'user-1', userType: 'CUSTOMER', count: 2, metas: [] },
      { transactionId: 'new', eventType: 'CREATE', entityType: 'AdGroup', eventTime: '2026-11-02T01:00:00.000Z', count: 1, metas: [] },
    ] }, 'apple');
    try {
      const rows = fixture.document.querySelectorAll('.workflow-timeline li');
      expect(rows[0]?.textContent).toContain('Transactionnew');
      expect(rows[1]?.textContent).toContain('Actoruser-1');
      expect(rows[1]?.textContent).toContain('Changes2');
    } finally { fixture.close(); }
  });

  it('compares experiment configuration without metrics or a serving action', () => {
    const fixture = mount('google_experiment_context', {
      account: { currencyCode: 'EUR', timeZone: 'Europe/Berlin' },
      experiment: { name: 'Brand experiment', status: 'ENABLED', startDate: '2026-11-18' },
      arms: [{ name: 'Control A', control: true, trafficSplit: '60', campaigns: ['base'] }, { name: 'Trial B', control: false, trafficSplit: '40', inDesignCampaigns: ['trial'] }],
      campaigns: [
        { campaign: { resourceName: 'base', name: 'Base', status: 'ENABLED' }, budget: { period: 'DAILY' }, budget_micros: 25500000 },
        { campaign: { resourceName: 'trial', name: 'Trial', status: 'PAUSED' }, budget: { period: 'DAILY' }, budget_micros: 27000001 },
      ],
    }, 'google');
    try {
      expect(fixture.document.querySelector('.workflow-arms')?.textContent).toContain('60%');
      expect(fixture.document.querySelector('.workflow-arms')?.textContent).toContain('€27.000001');
      expect(fixture.document.querySelector('button')).toBeNull();
    } finally { fixture.close(); }
  });

  it('shows keyword estimates at exact precision and leaves a gap between nonadjacent monthly observations', () => {
    const fixture = mount('google_keyword_ideas', { results: [{ text: 'app launch', keywordIdeaMetrics: {
      avgMonthlySearches: '9007199254740993', lowTopOfPageBidMicros: '1200001',
      monthlySearchVolumes: [{ year: '2026', month: 'JANUARY', monthlySearches: '5' }, { year: '2026', month: 'MARCH', monthlySearches: '9' }],
    } }] }, 'google');
    try {
      expect(fixture.document.querySelector('.planning-table')?.textContent).toContain('9007199254740993');
      expect(fixture.document.querySelector('.planning-table')?.textContent).toContain('1.200001 account units');
      expect(fixture.document.querySelector('.planning-table path')?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
    } finally { fixture.close(); }
  });

  it('shows Apple native recommendations with exact before and suggested values', () => {
    const fixture = mount('apple_recommendations', { result: [
      { campaignName: 'Brand', dailyBudget: { amount: '25.00', currency: 'EUR' }, suggestedDailyBudgetAmount: { amount: '30.000001', currency: 'EUR' } },
      { campaignName: 'Search', recommendedTargetCPA: { amount: '4.50', currency: 'EUR' } },
    ] }, 'apple');
    try {
      const items = fixture.document.querySelectorAll('.insight');
      expect(items[0]?.textContent).toContain('Current 25.00 EUR');
      expect(items[0]?.textContent).toContain('Suggested30.000001 EUR');
      expect(items[1]?.textContent).toContain('Target CPA');
      expect(fixture.document.querySelector('button')).toBeNull();
    } finally { fixture.close(); }
  });

  it('shows exact returned rows and completeness with normalized performance', () => {
    const fixture = mount('report', { summary: { complete: false }, rows: [
      { provider: 'google', currency: 'USD', entity: { name: 'Brand' }, metrics: { spend: 5, clicks: 1, conversions: 0 } },
    ] }, undefined, 'report');
    try {
      expect(fixture.document.querySelector('.notice')?.textContent).toContain('only the returned rows');
      expect(fixture.document.querySelector('.workflow-table tbody tr')?.textContent).toContain('BrandGoogle Ads—$5.0010—');
    } finally { fixture.close(); }
  });
});

describe('media distribution handoff', () => {
  it('requests one bound preview and then uses the existing Hold to apply control', async () => {
    const callTool = vi.fn(async () => ({ structuredContent: structuredResult(upload.tool, 'operation', {
      status: 'pending_validation', applied: false, pending_operation_id: 'new-token', expires_at: '2099-01-01T00:00:00Z',
      preview: { summary: 'Upload file', review: { title: 'Upload file', fields: [{ label: 'Asset', after: asset.name }] } },
    }, { arguments: { ...argumentsForUpload, ...project } }, project, { can_write: true }, undefined, undefined, { provider: 'google', accountId: 'account' }) }));
    const fixture = setup(callTool);
    try {
      fixture.send(structuredResult('media_distribution_plan', 'data', { asset, destinations: [upload, { ...upload, ready: false, problems: [{ field: 'board_id', message: 'Choose a board.' }] }] }, undefined, project, { can_write: true }));
      const button = fixture.document.querySelector<HTMLButtonElement>('[data-distribution-review]')!;
      expect(fixture.document.querySelectorAll('button')).toHaveLength(1);
      expect(fixture.document.querySelector('main')?.textContent).toContain('Choose a board.');
      button.click(); button.click();
      await vi.waitFor(() => expect(fixture.document.querySelector('[data-approve]')).not.toBeNull());
      expect(callTool).toHaveBeenCalledExactlyOnceWith(upload.tool, { ...argumentsForUpload, ...project });
    } finally { fixture.close(); }
  });

  it('hides invalid or read-only targets and preserves accepted versus ready status', () => {
    const fixture = setup();
    try {
      const data = { asset, destinations: [
        { ...upload, arguments: { ...argumentsForUpload, expected_sha256: 'wrong' } },
        { ...upload, arguments: { ...argumentsForUpload, pending_operation_id: 'attacker' } },
        { ...upload, arguments: { ...argumentsForUpload, project_id: 'other' } },
        { ...upload, tool: 'google_create_campaign' },
      ] };
      fixture.send(structuredResult('media_distribution_plan', 'data', data, undefined, project, { can_write: true }));
      expect(fixture.document.querySelector('button')).toBeNull();
      fixture.send(structuredResult('media_distribution_plan', 'data', { asset, destinations: [upload] }, undefined, project, { can_write: false }));
      expect(fixture.document.querySelector('button')).toBeNull();
      fixture.send(structuredResult('media_distributions', 'data', {
        distributions: [{ provider: 'google', account_id: 'account', status: 'ACCEPTED', resource_ids: ['returned-id'] }],
      }));
      expect(fixture.document.querySelector('.workflow-item')?.textContent).toContain('Upload accepted');
      expect(fixture.document.querySelector('.workflow-item')?.textContent).toContain('Processing readiness is unconfirmed.');
      expect(fixture.document.querySelector('button')).toBeNull();
    } finally { fixture.close(); }
  });
});

describe('hosted read paging from tool response to widget', () => {
  it('uses declared cursors for generic records and GA4 and Search Console reports', async () => {
    const projectId = 'b310e750-d001-4427-8184-09bd05920e01', range = { start_date: '2026-11-01', end_date: '2026-11-07' };
    const provider = Object.assign(new MockProvider() as AdProvider, { id: 'ga4', acquisitionAnalytics: {
      listGoals: async () => [],
      acquisitionReport: async (input: { cursor?: string }) => ({
        rows: [{ dimensions: { source: input.cursor ? 'second source' : 'first source', medium: 'cpc', campaign: 'trial' },
          metrics: { sessions: 4, conversions: 1, revenue: 10 } }],
        date_range: { start: range.start_date, end: range.end_date, timezone: 'UTC' }, currency: 'EUR', attribution: 'Session', revenue_basis: 'Purchases',
        notes: [], ...(!input.cursor ? { next_cursor: '1' } : {}),
      }),
    } });
    const runtime = await createContext({ providerModules: [{ provider, tools: [] }] });
    runtime.registry.register(gscTools({
      site: async () => null, inspectUrl: async () => null, sitemaps: async () => null,
      searchAnalytics: async input => ({
        rows: [{ dimensions: { query: input.start_row ? 'second' : 'first' }, metrics: { clicks: 1 } }],
        ...(!input.start_row ? { next_start_row: 1 } : {}),
      }),
    }));
    runtime.registry.register(defineTool({
      name: 'meta_list_campaigns', namespace: 'meta', description: 'Synthetic campaigns with a continuation',
      input: z.object({ account_id: z.string(), cursor: z.string().optional() }), annotations: { readOnly: true },
      pagination: { cursorInput: 'cursor' },
      async handler(input) {
        return {
          campaigns: [{ id: input.cursor ? 'c2' : 'c1', name: input.cursor ? 'Second campaign' : 'First campaign', daily_budget: '2501', status: 'PAUSED', currency: 'EUR' }],
          truncated: !input.cursor, ...(!input.cursor ? { next_cursor: 'next' } : {}),
        };
      },
    }));
    const resolve = vi.fn(async () => runtime);
    const server = createMcpServer({
      runtime: withProjectRouting(runtime, { list: async () => [], resolve }), productionOnly: true, scopes: ['tools:read'],
    });
    const client = new Client({ name: 'widget-read-paging-test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    const examples = [
      { tool: 'analytics_acquisition_report', args: { provider: 'ga4', account_id: '123', ...range }, selector: '[data-report-next]', rows: '.workflow-table', expected: 'second source', cursor: { cursor: '1' } },
      { tool: 'gsc_search_analytics', args: { account_id: 'sc-domain:example.org', dimensions: ['query'], ...range }, selector: '[data-report-next]', rows: '.report-data', expected: 'second', cursor: { start_row: 1 } },
      { tool: 'meta_list_campaigns', args: { account_id: 'act_1' }, selector: '[data-record-more]', rows: '.workflow-table', expected: 'Second campaign', cursor: { cursor: 'next' } },
    ];
    try {
      for (const example of examples) {
        const args = { ...example.args, project_id: projectId };
        const fixture = setup(vi.fn((name: string, input: Record<string, unknown>) => client.callTool({ name, arguments: input })));
        try {
          const initial = await client.callTool({ name: example.tool, arguments: args });
          expect(initial.isError).not.toBe(true);
          expect(initial.structuredContent).toMatchObject({ _adport: { context: { project_id: projectId }, next: { arguments: { ...args, ...example.cursor } } } });
          fixture.send(initial.structuredContent);
          const button = fixture.document.querySelector<HTMLButtonElement>(example.selector)!;
          expect(button).not.toBeNull();
          button.click(); button.click();
          await vi.waitFor(() => expect(fixture.document.querySelector(example.rows)?.textContent).toContain(example.expected));
          expect(fixture.callTool).toHaveBeenCalledOnce();
          expect(fixture.document.querySelector(example.selector)).toBeNull();
          if (example.tool === 'meta_list_campaigns') {
            expect(fixture.document.querySelectorAll('.workflow-table tbody tr')).toHaveLength(2);
            expect(fixture.document.querySelector('.workflow-table')?.textContent).toContain('25.01 EUR');
          }
        } finally { fixture.close(); }
      }
      expect(resolve.mock.calls).toHaveLength(6);
      expect(resolve.mock.calls.every(call => (call as unknown[])[0] === projectId)).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});
