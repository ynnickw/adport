import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';
import { NATIVE_REPORT_TOOLS } from '../src/native-report-ui.js';
import { PROVIDER_LOGOS } from '../src/provider-logos.js';
import { providerModules } from './provider-fixtures.js';
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
    const tools = providerModules().flatMap(module => module.tools);
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

  it('preserves breakdowns and attribution-specific Meta actions without inventing conversion totals', () => {
    const { dom, document } = mount('meta_insights', { rows: [{ ad_name: '<img src=x onerror=alert(1)>', country: 'DE', date_start: '2026-11-01', actions: [{ action_type: 'purchase', value: '2' }, { action_type: 'view_content', value: '8' }], action_values: [{ action_type: 'purchase', value: '18.123' }] }] });
    try {
      const row = document.querySelector('[data-native-report]')!;
      expect(row.textContent).toContain('<img src=x onerror=alert(1)>'); expect(row.querySelector('img')).toBeNull();
      expect(row.textContent).toContain('DE'); expect(row.textContent).toContain('2026-11-01');
      expect([...row.querySelectorAll('dd')].map(node => node.textContent)).toEqual(['2', '8', '18.123 account units']);
      expect(row.textContent).not.toContain('Conversions10');
    } finally { dom.window.close(); }
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
