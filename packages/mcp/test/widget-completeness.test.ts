import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult, type AdportView } from '../src/ui.js';

function mount(view: AdportView, data: unknown, tool = 'pinterest_keywords') {
  const callTool = vi.fn();
  const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } });
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult(tool, view, data) } } }));
  return { dom, document: dom.window.document, callTool };
}

describe('compact record, recommendation, receipt and trend views', () => {
  it('selects actual records before empty warnings, keeps all rows, units and provider notes', () => {
    const { dom, document, callTool } = mount('records', { warnings: [], items: Array.from({ length: 12 }, (_, i) => ({ id: String(i), value: 'Keyword '+i, match_type: 'EXACT', status: 'UNARCHIVED', daily_budget_micros: 1250000, currency: 'USD' })), notes: ['Campaign scope only. Unarchived is not delivery.'] });
    try {
      expect(document.querySelectorAll('.record-row')).toHaveLength(12);
      expect(document.querySelector('main')?.textContent).toContain('Keyword 11'); expect(document.querySelector('main')?.textContent).toContain('EXACT');
      expect(document.querySelector('main')?.textContent).toContain('$1.25'); expect(document.querySelector('main')?.textContent).toContain('Campaign scope only');
      expect(document.querySelector('button,form,input,select,textarea')).toBeNull(); expect(callTool).not.toHaveBeenCalled();
    } finally { dom.window.close(); }
  });
  it('keeps ordinary entities with READY status as records, rather than claiming a job completed', () => {
    const { dom, document } = mount('data', { id: 'asset', name: 'Private PDF', status: 'READY', content_type: 'application/pdf' }, 'media_get');
    try { expect(document.querySelector('.record-row')?.textContent).toContain('Private PDF'); expect(document.querySelector('.receipt-state')).toBeNull(); }
    finally { dom.window.close(); }
  });
  it('renders recommendation explanations and actions safely without opening Details', () => {
    const { dom, document } = mount('insights', { findings: [{ title: 'Budget pacing', detail: 'Spend is above plan <script>unsafe</script>', recommendation: 'Review the daily budget', status: 'open', severity: 'warn' }] }, 'audit_run');
    try {
      expect(document.querySelector('.insight-reason')?.textContent).toContain('Spend is above plan <script>unsafe</script>');
      expect(document.querySelector('.insight-action')?.textContent).toContain('Review the daily budget');
      expect(document.querySelector('button')).toBeNull(); expect(document.querySelector('.insight script')).toBeNull();
    } finally { dom.window.close(); }
  });
  it('shows explicit progress and per-item failures while keeping acceptance separate from completion', () => {
    const { dom, document } = mount('receipt', { status: 'ACCEPTED_FOR_PROCESSING', processed: false, total_count: 10, processed_count: 4, failed_count: 1, results: [{ id: 'row-a', status: 'SUCCEEDED' }, { id: 'row-b', status: 'FAILED', error: { message: 'Invalid field <literal>' } }] }, 'google_conversion_request_status');
    try {
      expect(document.querySelector('.receipt-state')?.textContent).toBe('Processing pending');
      expect(document.querySelector('progress')?.getAttribute('max')).toBe('10'); expect(document.querySelector('progress')?.getAttribute('value')).toBe('4');
      expect(document.querySelectorAll('.receipt-item')).toHaveLength(2); expect(document.querySelector('.receipt-items')?.textContent).toContain('Invalid field <literal>');
      expect(document.querySelector('button')).toBeNull();
    } finally { dom.window.close(); }
  });
  it('never turns resource IDs into processed counts or extrapolates unreported totals', () => {
    const { dom, document } = mount('receipt', { status: 'PROCESSING', resourceIds: ['one', 'two'] }, 'google_conversion_request_status');
    try { expect(document.querySelector('progress')).toBeNull(); expect(document.querySelector('.receipt-counts')).toBeNull(); expect(document.querySelector('main')?.textContent).not.toContain('Completed'); }
    finally { dom.window.close(); }
  });
  it('preserves overlapping Google diagnostic counts without inventing a successful count', () => {
    const { dom, document } = mount('receipt', { request_id: 'request', status: 'PARTIAL_SUCCESS', terminal: true, expected_event_count: 10, record_count: '10', errors: [{ reason: 'INVALID_EVENT', record_count: '3' }, { reason: 'MISSING_FIELD', record_count: '3' }], warnings: [], note: 'Diagnostic counts can overlap.' }, 'google_conversion_request_status');
    try {
      expect(document.querySelector('.receipt-state')?.textContent).toBe('Partially completed');
      expect(document.querySelector('.receipt-counts')?.textContent).toContain('Reported records10');
      expect(document.querySelector('.receipt-counts')?.textContent).not.toContain('Succeeded');
      expect(document.querySelector('.receipt-items')?.textContent).toContain('MISSING_FIELD'); expect(document.querySelector('progress')).toBeNull();
      expect(document.querySelector('main')?.textContent).toContain('Diagnostic counts can overlap');
    } finally { dom.window.close(); }
  });
  it('keeps a failed native job failed even when processed is false', () => {
    const { dom, document } = mount('receipt', { status: 'FAILED', processed: false }, 'google_conversion_request_status');
    try { expect(document.querySelector('.receipt-state')?.textContent).toBe('Failed'); }
    finally { dom.window.close(); }
  });
  it('plots real dated observations, breaks missing days and keeps missing values out of the series', () => {
    const row = (date: string, spend?: number) => ({ provider: 'google', accountId: 'one', currency: 'USD', date, entity: { id: 'one', name: 'Example' }, metrics: { spend, clicks: 1 } });
    const { dom, document } = mount('report', { rows: [row('2026-11-01', 10), row('2026-11-02'), row('2026-11-03', 30)], errors: [], warnings: [], granularity: 'day' }, 'report');
    try {
      expect(document.querySelectorAll('.report-trend circle')).toHaveLength(2);
      expect(document.querySelector('.trend-line')?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
      expect(document.querySelector('.report-trend svg')?.getAttribute('aria-label')).toContain('2026-11-03: $30.00');
      expect(document.querySelector('.bars')).toBeNull(); expect(document.querySelector('main')?.textContent).toContain('Missing or unavailable days remain gaps');
    } finally { dom.window.close(); }
  });
  it('keeps observations from another provider visible when a separate provider fails', () => {
    const { dom, document } = mount('report', { rows: [{ provider: 'apple', accountId: 'one', currency: 'EUR', date: '2026-11-01', entity: { id: 'one' }, metrics: { spend: 12 } }], errors: [{ provider: 'meta', date: '2026-11-01', message: 'Unavailable' }] }, 'report');
    try { expect(document.querySelectorAll('.report-trend circle')).toHaveLength(1); }
    finally { dom.window.close(); }
  });
});
