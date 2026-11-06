import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';

function mount(tool: string, data: unknown) {
  const callTool = vi.fn();
  const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } });
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult(tool, 'data', data, undefined, undefined, undefined, undefined, undefined, { provider: tool.split('_')[0] }) } } }));
  return { dom, document: dom.window.document, callTool };
}
const row = (name: string, spend: string, currency = 'EUR') => ({ metadata: { name }, totalMetrics: { localSpend: { amount: spend, currency }, taps: 0, totalInstalls: 0 } });

describe('chart-first provider reports', () => {
  it('charts native GA4 daily dates as one series while retaining exact currency values', () => {
    const { dom, document } = mount('ga4_report', { metadata: { currencyCode: 'EUR' }, metric_headers: [{ name: 'totalRevenue', type: 'TYPE_CURRENCY' }],
      rows: ['20261101', '20261102'].map(date => ({ dimensions: { date, sessionSourceMedium: 'google / cpc' }, metrics: { totalRevenue: '12.3456789' } })) });
    try {
      expect(document.querySelector('[data-native-line] svg')?.querySelectorAll('circle')).toHaveLength(2);
      expect(document.querySelector('[data-native-line]')?.textContent).toContain('google / cpc');
      expect(document.querySelector('details pre')?.textContent).toContain('12.3456789');
      expect(document.querySelector('.record-fields')?.textContent).toContain('12.3456789 EUR');
      expect(document.querySelector('.report-overview')).toBeNull();
    } finally { dom.window.close(); }
  });

  it('formats Search Console CTR as a percentage and keeps average position unaggregated', () => {
    const { dom, document } = mount('gsc_search_analytics', { rows: [{ dimensions: { query: 'adport' }, metrics: { ctr: 0.2, position: 3.5 } }] });
    try {
      expect(document.querySelector('.report-bars strong')?.textContent).toBe('20%');
      expect(document.querySelector('.report-chart-head')?.textContent).toContain('%');
      expect(document.querySelector('.record-fields')?.textContent).toContain('3.5');
      expect(document.querySelector('.report-overview')).toBeNull();
    } finally { dom.window.close(); }
  });

  it('binds analytics pagination to the selected property and filters', async () => {
    const callTool = vi.fn().mockResolvedValue({ isError: true });
    const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } });
    const args = { account_id: '123', project_id: 'project', start_date: '2026-11-01', end_date: '2026-11-05', metrics: ['sessions'], offset: 0 };
    const send = (next: Record<string, unknown>) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {
      structuredContent: structuredResult('ga4_report', 'data', { rows: [{ dimensions: {}, metrics: { sessions: '1' } }] }, undefined, { project_id: 'project' }, undefined, { arguments: args }, { arguments: next }, { provider: 'ga4', accountId: '123', pagination: { cursorInput: 'offset' } }),
    } } }));
    try {
      send({ ...args, account_id: 'other', offset: 1 }); expect(dom.window.document.querySelector('[data-report-next]')).toBeNull();
      send({ ...args, offset: 1 });
      (dom.window.document.querySelector('[data-report-next]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(callTool).toHaveBeenCalled());
      expect(callTool).toHaveBeenCalledWith('ga4_report', { ...args, offset: 1 });
      await vi.waitFor(() => expect(dom.window.document.querySelector('[data-report-page-status]')?.textContent).toContain('could not be confirmed'));
    } finally { dom.window.close(); }
  });

  it('shows the Apple comparison and one summary while keeping repeated row metrics collapsed', () => {
    const data = { result: { rows: [row('DE Search', '0'), row('US Search', '0.6515')], summary: { grandTotal: { localSpend: { amount: '0.6515', currency: 'EUR' }, taps: 2, totalInstalls: 0 } } }, pagination: { offset: 0, totalCount: 2 } };
    const { dom, document, callTool } = mount('apple_report', data);
    try {
      expect(document.querySelector('.report-overview')?.textContent).toBe('Total spend€0.65Taps2Installs0');
      expect(document.querySelectorAll('.report-bars li')).toHaveLength(2);
      expect(document.querySelector('[data-chart-value="0"] .report-bar-fill')?.getAttribute('style')).toContain('width:0.00000%');
      expect(document.querySelector('.report-data')?.hasAttribute('open')).toBe(false);
      expect(document.querySelector('.record-row')?.closest('details')).toBe(document.querySelector('.report-data'));
      expect(document.querySelector('.apple-report-page')).toBeNull();
      expect(document.querySelector('button,input,select')).toBeNull(); expect(callTool).not.toHaveBeenCalled();
    } finally { dom.window.close(); }
  });

  it('uses semantic Google lag labels, preserves duplicate groups and does not invent an aggregate', () => {
    const data = { rows: [['LESS_THAN_ONE_DAY', 18], ['ONE_TO_TWO_DAYS', 1], ['TWO_TO_THREE_DAYS', 2], ['TWO_TO_THREE_DAYS', 1], ['EIGHT_TO_NINE_DAYS', 1]].map(([conversionLagBucket, conversions]) => ({ metrics: { conversions, conversionsValue: 9 }, segments: { conversionLagBucket } })) };
    const { dom, document } = mount('google_gaql', data);
    try {
      expect(document.querySelector('.operation-heading')?.textContent).toContain('Conversion delay');
      expect([...document.querySelectorAll('.report-bars .report-bar-label > span')].map(el => el.textContent)).toEqual(['Under 1 day', '1–2 days', '2–3 days', '2–3 days', '8–9 days']);
      expect([...document.querySelectorAll('.report-bars strong')].map(el => el.textContent)).toEqual(['18', '1', '2', '1', '1']);
      expect(document.querySelector('.report-overview')).toBeNull();
      expect(document.querySelector('[data-report-chart]')?.textContent).not.toContain('Record');
    } finally { dom.window.close(); }
  });

  it('shows real daily points and breaks lines across absent or unavailable days', () => {
    const data = { rows: [1, 2, 4, 5, 6].map(day => ({ campaign: { name: 'Search' }, customer: { currencyCode: 'EUR' }, segments: { date: '2026-11-0' + day }, metrics: { costMicros: day === 5 ? null : String(day * 1000000) } })) };
    const { dom, document } = mount('google_gaql', data);
    try {
      const svg = document.querySelector('[data-native-line] svg')!;
      expect(svg.querySelectorAll('circle')).toHaveLength(4);
      expect(svg.querySelector('path')?.getAttribute('d')?.match(/ L/g)).toHaveLength(1);
      expect(svg.querySelector('path')?.getAttribute('d')?.match(/ M/g)).toHaveLength(3);
      expect(svg.textContent).not.toContain('2026-11-03');
      expect(svg.querySelector('circle title')?.textContent).toContain('1 EUR');
    } finally { dom.window.close(); }
  });

  it('separates currencies and keeps all-zero and missing values distinct', () => {
    const { dom, document } = mount('apple_report', { result: { rows: [row('Euro', '0'), row('Dollar', '3', 'USD'), { metadata: { name: 'Unavailable' } }] } });
    try {
      expect([...document.querySelectorAll('.report-chart-head > span')].map(el => el.textContent)).toEqual(['EUR', 'USD', 'Account units']);
      expect(document.querySelector('[data-chart-value="0"] strong')?.textContent).toBe('€0.00');
      expect(document.querySelector('[data-chart-value=""] strong')?.textContent).toBe('—');
      expect(document.querySelector('.report-overview')).toBeNull();
    } finally { dom.window.close(); }
  });

  it('renders impression-share bounds as a range and retains suppressed Spotify values without a bar', () => {
    const { dom, document } = mount('apple_impression_share', { result: { rows: [{ searchTerm: 'couples', lowImpressionShare: 0.91, highImpressionShare: 1 }] } });
    try {
      expect(document.querySelector('.report-bar-range')?.getAttribute('style')).toContain('left:91%');
      expect(document.querySelector('.report-bars strong')?.textContent).toBe('91%–100%');
    } finally { dom.window.close(); }
    const spotify = mount('spotify_insight_report', { rows: [{ name: 'IOS', stats: [{ field_type: 'PURCHASES', field_value: -5 }] }] });
    try {
      expect(spotify.document.querySelector('.report-bars strong')?.textContent).toBe('Suppressed');
      expect(spotify.document.querySelector('.report-bar-fill')?.getAttribute('style')).toContain('width:0.00000%');
    } finally { spotify.dom.window.close(); }
  });

  it('keeps Google non-metric queries as records and escapes native labels in charts', () => {
    const config = mount('google_gaql', { rows: [{ campaign: { name: 'Campaign settings' } }] });
    try { expect(config.document.querySelector('[data-report-chart]')).toBeNull(); } finally { config.dom.window.close(); }
    const { dom, document } = mount('apple_report', { result: { rows: [row('<img src=x onerror=alert(1)>', '2')] } });
    try { expect(document.querySelector('.report-bars img')).toBeNull(); expect(document.querySelector('.report-bars')?.textContent).toContain('<img src=x onerror=alert(1)>'); }
    finally { dom.window.close(); }
  });

  it('preserves LinkedIn USD fields independently of account currency and flags demographic coverage', () => {
    const { dom, document } = mount('linkedin_demographic_report', { currency: 'EUR', rows: [{ name: 'Software', metrics: { costInUsd: '1.123456789', clicks: 0 }, date_range: { start: '2026-11-01', end: '2026-11-03' } }], records: [{ name: 'Ignored alternate rendering' }], notes: ['Exact source privacy context.'] });
    try {
      expect(document.querySelector('.report-chart-head > span')?.textContent).toBe('USD');
      expect(document.querySelector('.report-bars strong')?.textContent).toBe('1.123456789 USD');
      expect(document.querySelector('.report-chart-foot')?.textContent).toContain('Approximate demographics');
      expect(document.querySelector('details pre')?.textContent).toContain('Exact source privacy context.');
    } finally { dom.window.close(); }
  });

  it('keeps negative reported values on the negative side of a shared zero baseline', () => {
    const { dom, document } = mount('google_gaql', { rows: [{ campaign: { name: 'Adjustment' }, metrics: { conversions: -2 } }, { campaign: { name: 'Conversions' }, metrics: { conversions: 6 } }] });
    try {
      const rows = document.querySelectorAll('.report-bars li');
      expect(rows[0]?.querySelector('.report-bar-fill')?.getAttribute('style')).toContain('left:0.00000%;width:25.00000%');
      expect(rows[1]?.querySelector('.report-bar-fill')?.getAttribute('style')).toContain('left:25.00000%;width:75.00000%');
      expect(rows[0]?.querySelector('strong')?.textContent).toBe('-2');
      expect(document.querySelector('.report-bar-zero')?.getAttribute('style')).toContain('25.00000%');
    } finally { dom.window.close(); }
  });

  it('does not let a queued resize from an older result redraw a newer account chart', () => {
    const callbacks: Array<() => void> = [];
    const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', beforeParse(window) { Object.defineProperty(window, 'ResizeObserver', { value: class { constructor(callback: () => void) { callbacks.push(callback); } observe() {} disconnect() {} } }); } });
    const send = (name: string) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult('google_gaql', 'data', { rows: [1, 2].map(day => ({ campaign: { name }, segments: { date: '2026-11-0' + day }, metrics: { clicks: day } })) }) } } }));
    try {
      send('Old account'); const oldResize = callbacks.at(-1)!;
      send('New account'); oldResize();
      expect(dom.window.document.querySelector('[data-native-line]')?.textContent).toContain('New account');
      expect(dom.window.document.querySelector('[data-native-line]')?.textContent).not.toContain('Old account');
    } finally { dom.window.close(); }
  });
});
