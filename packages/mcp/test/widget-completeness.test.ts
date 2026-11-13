import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult, type AdportView } from '../src/ui.js';
import { PROVIDER_LOGOS } from '../src/provider-logos.js';

function mount(view: AdportView, data: unknown, tool = 'pinterest_keywords', descriptor?: { provider: string }) {
  const callTool = vi.fn();
  const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } });
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult(tool, view, data, undefined, undefined, undefined, undefined, undefined, descriptor) } } }));
  return { dom, document: dom.window.document, callTool };
}

describe('compact record, recommendation, receipt and trend views', () => {
  it('keeps an unnamed native CAPI connection as one record instead of treating its empty activity as an empty inventory', () => {
    const { dom, document } = mount('records', { capi_integration: { capi_connection_id: 'native-capi-id', events_received: [] } }, 'spotify_get_capi_integration', { provider: 'spotify' });
    try { expect(document.querySelectorAll('.record-row')).toHaveLength(1);expect(document.querySelector('.record-name strong')?.textContent).toBe('native-capi-id'); }
    finally { dom.window.close(); }
  });
  it.each([['spotify_get_dataset','dataset'], ['spotify_get_capi_integration','capi_integration'], ['spotify_get_mobile_app','mobile_app']])('shows a single named Spotify measurement record: %s', (tool, key) => {
    const { dom, document, callTool } = mount('records', { [key]: { name: 'Private QA measurement', id: 'safe-id', configuration_hash: 'private-hash' }, resource_receipt: 'signed-recovery-proof' }, tool, { provider: 'spotify' });
    try { expect(document.querySelectorAll('.record-row')).toHaveLength(1);expect(document.querySelector('.record-name strong')?.textContent).toBe('Private QA measurement');expect(document.querySelector('.record-list')?.textContent).not.toMatch(/private-hash|signed-recovery-proof|Record 1/);expect(document.querySelector('.operation-heading .logo.spotify svg')).not.toBeNull();expect(callTool).not.toHaveBeenCalled(); }
    finally { dom.window.close(); }
  });
  it.each(['tiktok_get_pixel', 'tiktok_pixels'])('shows one named Pixel with its native flags kept together: %s', tool => {
    const pixel = { pixel_id: '9007199254740993123', pixel_name: 'Synthetic Pixel', pixel_code: 'QA_PIXEL_CODE', events: ['ViewContent'], advanced_matching_fields: { email: false, phone_number: false }, configuration_hash: 'private-configuration' };
    const { dom, document, callTool } = mount('records', tool === 'tiktok_pixels' ? { pixels: [pixel], complete: true } : { pixel }, tool, { provider: 'tiktok' });
    try {
      expect(document.querySelectorAll('.record-row')).toHaveLength(1);
      expect(document.querySelector('.record-name strong')?.textContent).toBe('Synthetic Pixel');
      expect(document.querySelector('.record-list')?.textContent).not.toMatch(/private-configuration|QA_PIXEL_CODE|9007199254740993123|Record 1/);
      expect(document.querySelector('details')?.textContent).toContain('9007199254740993123');expect(callTool).not.toHaveBeenCalled();
    } finally { dom.window.close(); }
  });
  it.each(['tiktok_get_saved_audience', 'tiktok_saved_audiences'])('shows native saved-audience names and keeps targeting arrays inside one record: %s', tool => {
    const audience = { saved_audience_id: '9007199254740993123', saved_audience_name: 'Synthetic targeting', location_ids: ['6252001'], languages: ['en'], snapshot_hash: 'private-snapshot' };
    const { dom, document, callTool } = mount('records', tool === 'tiktok_saved_audiences' ? { saved_audiences: [audience], complete: true } : { audience }, tool, { provider: 'tiktok' });
    try {
      expect(document.querySelectorAll('.record-row')).toHaveLength(1);
      expect(document.querySelector('.record-name strong')?.textContent).toBe('Synthetic targeting');
      expect(document.querySelector('.record-list')?.textContent).not.toMatch(/private-snapshot|9007199254740993123|Record 1/);
      expect(document.querySelector('details')?.textContent).toContain('9007199254740993123');
      expect(document.querySelector('.operation-heading .logo.tiktok svg')).not.toBeNull();expect(callTool).not.toHaveBeenCalled();
    } finally { dom.window.close(); }
  });
  it.each(Object.keys(PROVIDER_LOGOS))('retains the real %s provider mark on generic tool results', provider => {
    const { dom, document } = mount('data', { items: [{ name: 'Example record', status: 'ACTIVE' }] }, provider+'_records', { provider });
    try { expect(document.querySelector('.operation-heading .logo.'+provider+' svg')).not.toBeNull(); }
    finally { dom.window.close(); }
  });
  it('keeps provider identity in planning headers while paging native estimates', () => {
    const { dom, document } = mount('planning', { planning: { title: 'Supply forecast', columns: [{ key: 'impressions', label: 'Impressions' }], rows: Array.from({ length: 101 }, (_, impressions) => ({ impressions })) } }, 'linkedin_supply_forecast', { provider: 'linkedin' });
    try {
      expect(document.querySelector('.operation-heading .logo.linkedin svg')).not.toBeNull();
      (document.querySelector('[data-planning-page="next"]') as HTMLButtonElement).click();
      expect(document.querySelector('.operation-heading .logo.linkedin svg')).not.toBeNull();
    } finally { dom.window.close(); }
  });
  it('shows the actual daily report providers after changing chart metrics', () => {
    const { dom, document } = mount('report', { rows: ['google','apple'].map(provider => ({ provider, accountId: provider, currency: 'EUR', date: '2026-11-01', entity: { id: provider }, metrics: { spend: 1, clicks: 2 } })), errors: [] }, 'report');
    try {
      expect(document.querySelectorAll('.report-trend .record-provider')).toHaveLength(2);
      (document.querySelector('[data-metric="clicks"]') as HTMLButtonElement).click();
      expect(document.querySelectorAll('.report-trend .record-provider')).toHaveLength(2);
    } finally { dom.window.close(); }
  });
  it('shows all project provider logos, the saved project logo, and no duplicated organization or raw ID', () => {
    const providers=Object.keys(PROVIDER_LOGOS);
    const { dom, document, callTool } = mount('data', { projects: [{ id: 'private-project-id', name: 'Adport', organization_name: 'Adport', role: 'owner', providers, logo_url: 'https://example.test/project.png' }] }, 'projects_list');
    try {
      expect(document.querySelector('.operation-heading h2')?.textContent).toBe('Projects');
      expect(document.querySelector('.project-logo img')?.getAttribute('src')).toBe('https://example.test/project.png');
      expect(document.querySelectorAll('.record-provider')).toHaveLength(providers.length);
      expect(document.querySelector('.project-copy')?.textContent).toBe('AdportOwner');
      expect(document.querySelector('.record-list')?.textContent).not.toContain('private-project-id');
      expect(document.querySelector('details')?.textContent).toContain('private-project-id');
      expect(document.querySelector('button,input,select,textarea')).toBeNull(); expect(callTool).not.toHaveBeenCalled();
      document.querySelector('.project-logo img')?.dispatchEvent(new dom.window.Event('error'));
      expect(document.querySelector('.project-logo')?.textContent).toBe('A');
    } finally { dom.window.close(); }
  });
  it('keeps empty and unsafe project logos honest and preserves long names and organization context', () => {
    const { dom, document } = mount('data', { projects: [{ id: 'one', name: '<Product>', organization_name: 'Company', role: 'viewer', providers: [], logo_url: 'javascript:alert(1)' }, { id: 'two', name: 'Another project', role: 'admin', providers: ['future-provider'] }] }, 'projects_list');
    try {
      expect(document.querySelector('img')).toBeNull(); expect(document.querySelector('.project-copy')?.textContent).toBe('<Product>Company · Viewer');
      expect(document.querySelector('.project-platforms-empty')?.textContent).toBe('No connected platforms');
      expect(document.querySelector('.record-provider-name')?.textContent).toBe('future-provider');
      expect(document.querySelector('.project-row script')).toBeNull();
    } finally { dom.window.close(); }
  });
  it('uses provider identity and all provider marks in other mixed record lists', () => {
    const { dom, document } = mount('data', { items: [{ display_name: 'Search account', provider: 'google', status: 'ACTIVE', platforms: ['google', 'meta', 'apple', 'x', 'linkedin'] }, { account_name: 'Social account', provider: 'meta' }] }, 'connected_accounts');
    try {
      expect(document.querySelectorAll('.record-name .logo')).toHaveLength(2);
      expect(document.querySelector('.record-name strong')?.textContent).toBe('Search account');
      expect(document.querySelectorAll('.record-provider')).toHaveLength(5);
      expect(document.querySelector('.record-list')?.textContent).not.toContain('more in Details');
    } finally { dom.window.close(); }
  });
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
      expect(document.querySelectorAll('[data-report-trend] circle')).toHaveLength(2);
      expect(document.querySelector('.trend-line')?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
      expect(document.querySelector('[data-report-trend] svg')?.getAttribute('aria-label')).toContain('2026-11-03: $30.00');
      expect(document.querySelector('.bars')).toBeNull(); expect(document.querySelector('main')?.textContent).toContain('Missing or unavailable days remain gaps');
    } finally { dom.window.close(); }
  });
  it('keeps observations from another provider visible when a separate provider fails', () => {
    const { dom, document } = mount('report', { rows: [{ provider: 'apple', accountId: 'one', currency: 'EUR', date: '2026-11-01', entity: { id: 'one' }, metrics: { spend: 12 } }], errors: [{ provider: 'meta', date: '2026-11-01', message: 'Unavailable' }] }, 'report');
    try { expect(document.querySelectorAll('[data-report-trend] circle')).toHaveLength(1); }
    finally { dom.window.close(); }
  });
});
