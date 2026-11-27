import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';
import { NATIVE_REPORT_TOOLS } from '../src/native-report-ui.js';
import { PROVIDER_LOGOS } from '../src/provider-logos.js';
import { providerModules } from './provider-fixtures.js';
import { AnalyticsClient, Ga4Provider, SearchConsoleProvider, ga4Tools, gscTools } from '@adport/provider-analytics';
import fixtures from './fixtures/native-report-cases.json';

function mount(tool: string, data: unknown, view: 'data' | 'report' = 'data') {
  const callTool = vi.fn();
  const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } });
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult(tool, view, data, undefined, undefined, undefined, undefined, undefined, { provider: tool.split('_')[0] }) } } }));
  return { dom, document: dom.window.document, callTool };
}

// Fixtures follow provider request/response tests and official Apple v1 SDK,
// Spotify v3 insight_reports and TikTok v1.3 reporting contracts (2026-11-05).
describe('native report renderers', () => {
  it('covers each configured native read using the real tool definitions', () => {
    const client = new AnalyticsClient({ clientId: 'x', clientSecret: 'x', refreshToken: 'x' });
    const tools = [...providerModules().flatMap(module => module.tools), ...ga4Tools(new Ga4Provider(client)), ...gscTools(new SearchConsoleProvider(client))];
    expect(new Set(fixtures.map(f => f.tool))).toEqual(new Set(NATIVE_REPORT_TOOLS));
    for (const name of NATIVE_REPORT_TOOLS) expect(tools.find(tool => tool.name === name)?.annotations.readOnly, name).toBe(true);
  });

  it.each(fixtures)('renders useful identity and metrics for $tool without controls or tool calls', fixture => {
    const { dom, document, callTool } = mount(fixture.tool, fixture.data);
    try {
      const row = document.querySelector('[data-native-report] .record-row')!;
      expect(row.querySelector('.record-heading strong')?.textContent).toBe(fixture.name);
      expect([...row.querySelectorAll('dd')].map(node => node.textContent)).toEqual(fixture.values);
      expect(row.textContent).not.toMatch(/Record 1|Metadata/);
      expect(document.querySelector('.operation-heading .logo.'+fixture.tool.split('_')[0]+' svg')).not.toBeNull();
      expect(document.querySelector('button,input,select,textarea')).toBeNull(); expect(callTool).not.toHaveBeenCalled();
      expect(JSON.parse(document.querySelector('details pre')!.textContent!)).toEqual(fixture.data);
    } finally { dom.window.close(); }
  });

  it.each(NATIVE_REPORT_TOOLS)('keeps missing and empty %s responses distinct from zero metrics', tool => {
    for (const data of [{ ...(tool === 'reddit_report' ? { metrics: [] } : { rows: [] }) }, { unexpected: true }]) {
      const { dom, document } = mount(tool, data);
      try {
        if(tool==='google_gaql') { expect(document.querySelector('[data-report-chart]')).toBeNull(); continue; }
        expect(document.querySelector('[data-native-report]')?.textContent).toMatch(/No report rows returned|Report rows unavailable/);
        expect(document.querySelector('dd')).toBeNull();
      } finally { dom.window.close(); }
    }
  });

  it('retains exact Reddit micros and cents without currency invention or floating-point rounding', () => {
    const { dom, document } = mount('reddit_report', { metrics: [{ campaign_id: 'one', spend: '9007199254740993', conversion_purchase_total_value: '9007199254740993', clicks: 0 }] });
    try {
      expect(document.querySelector('[data-native-report]')?.textContent).toContain('9007199254.740993 account units');
      expect(document.querySelector('[data-native-report]')?.textContent).toContain('90071992547409.93 account units');
      expect(document.querySelector('[data-native-report]')?.textContent).not.toContain('$');
    } finally { dom.window.close(); }
  });

  it('also suppresses anonymous comparisons in other native reports', () => {
    const metrics = [8011897,2100497].map(spend => ({ spend, date_start:'2026-10-21', date_stop:'2026-11-27' }));
    const { dom, document } = mount('reddit_report', { metrics });
    try {
      expect(document.querySelector('.report-bars,[data-native-line]')).toBeNull();
      expect(document.querySelector('[data-native-report] .operation-note')?.textContent).toContain('no distinguishing labels');
      expect(JSON.parse(document.querySelector('details pre')!.textContent!).metrics).toEqual(metrics);
    } finally { dom.window.close(); }
  });

  it('preserves breakdowns and attribution-specific Meta actions without inventing conversion totals', () => {
    const { dom, document } = mount('meta_insights', { rows: [{ ad_name: '<img src=x onerror=alert(1)>', country: 'DE', date_start: '2026-11-01', actions: [{ action_type: 'purchase', value: '2' }, { action_type: 'view_content', value: '8' }], action_values: [{ action_type: 'purchase', value: '18.123' }] }] });
    try {
      const row = document.querySelector('[data-native-report]')!;
      expect(row.textContent).toContain('<img src=x onerror=alert(1)>'); expect(row.querySelector('img')).toBeNull();
      expect(row.textContent).toContain('DE'); expect(row.textContent).toContain('2026-11-01');
      expect([...row.querySelectorAll('details dd')].map(node => node.textContent)).toEqual(['2', '8', '18.123 account units']);
      expect(row.textContent).not.toContain('Conversions10');
    } finally { dom.window.close(); }
  });

  it('ranks the full Meta placement breakdown by spend and shows its outcomes beside it', () => {
    const rows = Array.from({ length: 17 }, (_, i) => ({
      date_start: '2026-10-21', date_stop: '2026-11-27', account_currency: 'EUR',
      publisher_platform: i % 2 ? 'facebook' : 'instagram', platform_position: i === 16 ? 'reels' : 'placement_' + i,
      spend: i === 16 ? '414.94826' : '8.011897', clicks: String(i), actions: [{ action_type: 'purchase', value: String(i % 3) }],
    }));
    const { dom, document, callTool } = mount('meta_insights', { rows });
    try {
      const table = document.querySelector('table')!;
      expect(table.closest('details')).toBeNull();
      expect([...table.querySelectorAll('thead th')].map(node => node.textContent)).toEqual(['Platform / Placement', 'Spend · EUR', 'Purchases', 'Clicks']);
      expect(table.querySelector('[aria-sort="descending"]')?.textContent).toBe('Spend · EUR');
      expect(table.querySelectorAll('tbody tr')).toHaveLength(17);
      expect([...table.querySelector('tbody tr')!.children].map(node => node.textContent)).toEqual(['Instagram · Reels', '414.95', '1', '16']);
      expect(document.querySelector('.operation-heading p')?.textContent).toMatch(/Oct 21.*Nov 27, 2026/);
      expect(table.textContent).not.toMatch(/Result \d|2026|account units/);
      expect(document.querySelector('.report-bars')).toBeNull();
      expect(JSON.parse(document.querySelector('details pre')!.textContent!).rows).toEqual(rows);
      expect(callTool).not.toHaveBeenCalled();
    } finally { dom.window.close(); }
  });

  it('collapses an anonymous Meta projection to a useful explanation and its exact rows', () => {
    const rows = ['8.011897','2.100497','414.94826'].map(spend => ({date_start:'2026-10-21', date_stop:'2026-11-27', spend}));
    const { dom, document } = mount('meta_insights', { rows });
    try {
      expect(document.querySelector('table,.report-bars,[data-native-line]')).toBeNull();
      expect(document.querySelector('[data-native-report] .operation-note')?.textContent).toMatch(/no distinguishing labels.*breakdown such as placement/);
      expect(document.querySelector('.operation-heading p')?.textContent).toContain('Currency unavailable');
      expect(document.querySelector('details')?.open).toBe(false);
      expect(JSON.parse(document.querySelector('details pre')!.textContent!).rows).toEqual(rows);
    } finally { dom.window.close(); }
  });

  it('ranks all returned spend before applying the Meta table display limit', () => {
    const rows = Array.from({length:1001}, (_,i) => ({campaign_name:'Campaign '+i, spend:String(i), account_currency:'USD'}));
    const { dom, document } = mount('meta_insights', { rows });
    try {
      expect(document.querySelectorAll('tbody tr')).toHaveLength(1000);
      expect(document.querySelector('tbody th')?.textContent).toBe('Campaign 1000');
      expect(document.querySelector('[data-native-report] .operation-note')?.textContent).toContain('1,000 of 1,001 returned rows');
      expect(JSON.parse(document.querySelector('details pre')!.textContent!).rows).toHaveLength(1001);
    } finally { dom.window.close(); }
  });

  it('uses explicit Meta breakdowns, including numeric IDs, without assigning a missing currency', () => {
    const rows = [{ postback_sequence_index:'0', spend:'0' }, { postback_sequence_index:'1', spend:'0.00325' }, { postback_sequence_index:'2' }];
    const { dom, document } = mount('meta_insights', { rows, breakdowns:['postback_sequence_index'] });
    try {
      expect(document.querySelector('h2')?.textContent).toContain('postback sequence index');
      expect([...document.querySelectorAll('.report-bar-label span')].map(node => node.textContent)).toEqual(['1','0','2']);
      expect([...document.querySelectorAll('.report-bar-label strong')].map(node => node.textContent)).toEqual(['<0.01','0.00','—']);
      expect(document.querySelector('main')?.textContent?.match(/Currency unavailable/g)).toHaveLength(1);
      expect(document.querySelector('.report-chart')?.textContent).not.toMatch(/account units|[$€]/i);
    } finally { dom.window.close(); }
  });

  it('keeps reused Meta names and different currencies distinguishable without ranking the amounts', () => {
    const rows = [{ad_name:'Launch',ad_id:'51',account_currency:'EUR',spend:'2.015'}, {ad_name:'Launch',ad_id:'52',account_currency:'JPY',spend:'514.2'}];
    const { dom, document } = mount('meta_insights', { rows });
    try {
      const cells = [...document.querySelectorAll('tbody tr')].map(row => [...row.children].map(cell => cell.textContent));
      expect(cells).toEqual([['Launch (51)','2.02 EUR'],['Launch (52)','514 JPY']]);
      expect(document.querySelector('.report-bars,[aria-sort]')).toBeNull();
    } finally { dom.window.close(); }
  });

  it('shows a single reported value directly and keeps genuine daily Meta observations together', () => {
    const row = {campaign_name:'Spring sale', impressions:'10500', ctr:'2.34', spend:'8.011897', account_currency:'USD'};
    const single = mount('meta_insights', { rows:[row] });
    try {
      expect(single.document.querySelector('.meta-insight-kpis')?.textContent).toBe('Spend · USD8.01Impressions10,500CTR2.34%');
      expect(single.document.querySelector('.report-bars')).toBeNull();
    } finally { single.dom.window.close(); }
    const daily = mount('meta_insights', { rows:['01','02'].map(day => ({campaign_name:'Spring sale', date_start:'2026-11-'+day, date_stop:'2026-11-'+day, clicks:'3'})) });
    try {
      expect(daily.document.querySelectorAll('[data-native-line] circle')).toHaveLength(2);
      expect(daily.document.querySelector('circle title')?.textContent).toContain('Spring sale');
    } finally { daily.dom.window.close(); }
  });

  it('keeps Microsoft per-goal failures, absent summaries and diagnostic ratios visible', () => {
    const f = fixtures.find(value => value.tool === 'microsoft_offline_conversion_goal_report')!;
    const { dom, document } = mount(f.tool, { ...f.data, not_returned_goal_ids: ['101', '102'] });
    try {
      expect(document.querySelector('main')?.textContent).toContain('Upload diagnostics');
      expect(document.querySelector('main')?.textContent).toContain('Goal 101: GoalNotFound');
      expect(document.querySelector('main')?.textContent).toContain('No summary returned for goal 102.');
      expect(document.querySelector('main')?.textContent).not.toContain('No summary returned for goal 101.');
      expect(document.querySelector('[data-native-report]')?.textContent).toContain('Success rate · ratio0.000001');
    } finally { dom.window.close(); }
  });

  it.each(Object.keys(PROVIDER_LOGOS).filter(provider => !['mock','demo'].includes(provider)))('retains normalized performance reporting for %s', provider => {
    const { dom, document, callTool } = mount('report', { rows: [{ provider, accountId: 'one', currency: 'EUR', entity: { id: 'campaign-1', name: 'Named campaign' }, metrics: { spend: 1.25, clicks: 3, conversions: 1 } }] }, 'report');
    try {
      expect(document.querySelector('.bar-name')?.textContent).toContain('Named campaign');
      expect(document.querySelector('.bar-name .logo.'+provider+' svg')).not.toBeNull();
      expect(document.querySelector('.kpis')?.textContent).toContain('€1.25'); expect(callTool).not.toHaveBeenCalled();
    } finally { dom.window.close(); }
  });
});
