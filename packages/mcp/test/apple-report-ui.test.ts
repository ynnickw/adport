import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';

function mount(data: unknown) {
  const callTool = vi.fn();
  const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } });
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult('apple_report', 'data', data, undefined, undefined, undefined, undefined, undefined, { provider: 'apple', accountId: '123' }) } } }));
  return { dom, document: dom.window.document, callTool };
}

// Shapes: Apple's official v1 SDK e81717d1, Apps*ReportRow / AppsMetrics /
// ReportingKeyword / ReportingSearchTerm, checked 2026-11-05.
const metrics = (amount: string, taps: number, installs: number, currency = 'EUR') => ({ localSpend: { amount, currency }, taps, totalInstalls: installs, totalAvgCPI: { amount: installs ? String(Number(amount) / installs) : '0', currency } });
const campaign = (name = 'DE Search') => ({ metadata: { id: 42, name, displayStatus: 'RUNNING', dailyBudget: { value: { amount: '5', currency: 'EUR' } }, promotedObjectType: 'APPSTORE_APP' }, totalMetrics: metrics('1.964', 5, 1) });

describe('native Apple report presentation', () => {
  it('shows nested entity names and actual metrics instead of generic metadata records', () => {
    const { dom, document, callTool } = mount({ result: { rows: [campaign(), { ...campaign('US Discovery'), totalMetrics: metrics('1.5017', 6, 0) }, { ...campaign('US Search'), totalMetrics: metrics('5.5572', 14, 2) }], summary: { grandTotal: metrics('9.023', 25, 3) } }, pagination: { offset: 0, pageSize: 3, totalCount: 3 } });
    try {
      const content = document.querySelector('[data-apple-report]')!;
      expect(content.textContent).toContain('DE Search'); expect(content.textContent).toContain('€1.96');
      expect(content.textContent).toContain('US Discovery'); expect(content.textContent).not.toContain('Record 1');
      expect(content.textContent).not.toContain('Metadata'); expect(content.textContent).not.toContain('APPSTORE_APP');
      expect(document.querySelector('.apple-report-total')?.textContent).toContain('€9.02');
      expect(document.querySelector('.apple-report-total')?.textContent).toContain('25');
      expect(document.querySelector('.apple-report-total')?.textContent).toContain('€3.01');
      expect(document.querySelectorAll('[data-apple-report] > .record-row')).toHaveLength(3);
      expect(document.querySelector('.operation-heading .apple svg')).not.toBeNull();
      expect(document.querySelector('details pre')?.textContent).toContain('dailyBudget');
      expect(document.querySelectorAll('button,input,select,textarea')).toHaveLength(0); expect(callTool).not.toHaveBeenCalled();
    } finally { dom.window.close(); }
  });

  it('keeps missing values unavailable, preserves real zeros and does not invent totals or CPI', () => {
    const { dom, document } = mount({ result: { rows: [{ metadata: { name: 'No metrics' } }, { metadata: { name: 'Zero installs' }, totalMetrics: { ...metrics('0', 0, 0), totalAvgCPI: { amount: '0', currency: 'EUR' } } }] } });
    try {
      const rows = document.querySelectorAll('[data-apple-report] > .record-row');
      expect(rows[0]?.querySelectorAll('dd')?.length).toBe(4);
      expect([...rows[0]!.querySelectorAll('dd')].map(el => el.textContent)).toEqual(['—', '—', '—', '—']);
      expect([...rows[1]!.querySelectorAll('dd')].map(el => el.textContent)).toEqual(['€0.00', '0', '0', '—']);
      expect(document.querySelector('.apple-report-total')).toBeNull();
    } finally { dom.window.close(); }
  });

  it('preserves granular periods and breakdowns without adding them to row totals', () => {
    const { dom, document } = mount({ result: { rows: [{ ...campaign(), metadata: { name: 'Search', countryOrRegion: 'DE', deviceClass: 'IPHONE' }, granularMetrics: [{ date: '2026-11-01', ...metrics('1', 2, 1) }, { date: '2026-11-03', ...metrics('0.964', 3, 0) }] }] } });
    try {
      expect(document.querySelector('.apple-report-dimensions')?.textContent).toContain('DE');
      expect(document.querySelector('.apple-report-dimensions')?.textContent).toContain('IPHONE');
      expect(document.querySelectorAll('.apple-report-period')).toHaveLength(2);
      expect(document.querySelector('.apple-report-periods')?.textContent).toContain('2026-11-01');
      expect(document.querySelector('.apple-report-periods')?.textContent).not.toContain('2026-11-02');
      expect(document.querySelector('[data-apple-report] > .record-row > .record-fields')?.textContent).toContain('€1.96');
    } finally { dom.window.close(); }
  });

  it.each([{ text: 'couple widgets', matchType: 'EXACT' }, { searchTermText: 'shared countdown', keyword: { text: 'couples', matchType: 'BROAD' } }, { name: 'Ad group' }, { name: 'Product page ad' }])('uses native entity identity and escapes content: %j', metadata => {
    const { dom, document } = mount({ result: { rows: [{ metadata, totalMetrics: metrics('2', 4, 1) }, campaign('<img src=x onerror=alert(1)>')] } });
    try {
      expect(document.querySelector('[data-apple-report] strong')?.textContent).toBe('searchTermText' in metadata ? metadata.searchTermText : 'text' in metadata ? metadata.text : metadata.name);
      expect(document.querySelector('[data-apple-report] img')).toBeNull();
      expect(document.querySelector('[data-apple-report]')?.textContent).toContain('<img src=x onerror=alert(1)>');
    } finally { dom.window.close(); }
  });

  it('keeps currencies per row and identifies pagination and provider totals separately', () => {
    const { dom, document } = mount({ result: { rows: [campaign(), { metadata: { name: 'US' }, totalMetrics: metrics('3', 2, 1, 'USD') }], summary: { grandTotal: metrics('99', 100, 10) } }, pagination: { offset: 2, pageSize: 2, totalCount: 8 } });
    try {
      expect(document.querySelector('[data-apple-report]')?.textContent).toContain('€1.96');
      expect(document.querySelector('[data-apple-report]')?.textContent).toContain('$3.00');
      expect(document.querySelector('.apple-report-total')?.textContent).toContain('Report total');
      expect(document.querySelector('.apple-report-total')?.textContent).toContain('€99.00');
      expect(document.querySelector('.apple-report-page')?.textContent).toBe('Showing 3–4 of 8 results');
    } finally { dom.window.close(); }
  });

  it('shows empty and unrecognized response states without claiming zero performance', () => {
    for (const data of [{ result: { rows: [] } }, { result: { unexpected: true } }]) {
      const { dom, document } = mount(data);
      try {
        expect(document.querySelector('[data-apple-report]')?.textContent).toMatch(/No report rows|Report rows unavailable/);
        expect(document.querySelector('.apple-report-total')).toBeNull();
        expect(document.querySelector('details pre')?.textContent).toBeTruthy();
      } finally { dom.window.close(); }
    }
  });
});
