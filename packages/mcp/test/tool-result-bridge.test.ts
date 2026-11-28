import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';

const textResult = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const ad = { id: '101', account_id: '42', name: 'November video', status: 'ACTIVE', effective_status: 'ADSET_PAUSED' };
const literalCopy = JSON.stringify(textResult({ headline: 'This is ad copy' }));
const changeStatus = { label: 'Change status', tool: 'meta_set_ad_status', arguments: { account_id: ad.account_id, ad_id: ad.id },
  fields: [{ key: 'status', label: 'Status', type: 'select', value: ad.status, options: [{ value: 'ACTIVE', label: 'Active' }, { value: 'PAUSED', label: 'Paused' }] }] };
const ads = { ads: [ad], creatives: [{ id: ad.id, account_id: ad.account_id, provider: 'meta', name: ad.name,
  status: ad.status, type: 'VIDEO', descriptions: [literalCopy], actions: [changeStatus] }], truncated: false };
const metrics = { localSpend: { currency: 'EUR', amount: '21.6537' }, impressions: 341, taps: 63, totalInstalls: 12 };
const apple = { result: { rows: [{ totalMetrics: metrics, metadata: { name: 'Brand search' } }] } };

let dom: JSDOM;
function widget(globals?: Record<string, unknown>) {
  dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', beforeParse(window) {
    Object.defineProperty(window, 'openai', { value: globals });
  } });
  return dom.window.document;
}
function message(data: Record<string, unknown>) {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', ...data } }));
}
function result(params: unknown) { message({ method: 'ui/notifications/tool-result', params }); }
function globals(value: Record<string, unknown>) {
  dom.window.dispatchEvent(new dom.window.CustomEvent('openai:set_globals', { detail: { globals: value } }));
}
afterEach(() => dom.window.close());

describe('forwarded MCP tool results', () => {
  it('opens the Meta ad gallery from text-only globals and preserves literal creative copy', () => {
    const document = widget({ toolOutput: textResult(textResult(ads)) });
    expect(document.querySelector('.creative-name')?.textContent).toBe(ad.name);
    expect(document.querySelector('.creative-status')?.textContent).toBe('Ad set paused');
    expect(document.querySelector('.creative-copy p')?.textContent).toBe(literalCopy);
    expect(document.querySelector('button,form,[data-record-details]')).toBeNull();
  });

  it('reads Apple row metrics from forwarded text and keeps the disclosure open across bridge deliveries', () => {
    const document = widget();
    result(textResult(textResult(apple)));
    const report = document.querySelector('[data-apple-report]');
    expect(report?.querySelector('[data-report-chart]')?.textContent).toContain('€21.65');
    const overview = report?.querySelector('[aria-label="Returned row metrics"]');
    expect(overview?.textContent).toBe('Spend · Brand search€21.65Taps63Installs12');
    expect([...report!.querySelectorAll('.record-row dd')].map(cell => cell.textContent)).toEqual(['€21.65', '63', '12', '—']);
    expect(report?.querySelector('.apple-report-total')).toBeNull();
    const details = report!.querySelector('details')!;
    expect(JSON.parse(details.querySelector('pre')!.textContent!)).toEqual(apple);
    details.open = true;
    globals({ toolOutput: { structuredContent: textResult(apple) } });
    expect(document.querySelector('details')).toBe(details);
    expect(details.open).toBe(true);
  });

  it('prefers the original structured result over its text alternative', () => {
    const document = widget();
    const payload = structuredResult('meta_list_ads', 'creatives', ads);
    globals({ toolResponseMetadata: { mcp_tool_result: textResult({ ...textResult({ message: 'Text fallback' }), structuredContent: payload }) } });
    expect(document.querySelector('.creative-name')?.textContent).toBe(ad.name);
    expect(document.querySelector('main')?.textContent).not.toContain('Text fallback');
  });

  it('keeps actions scoped to host metadata and edits the configured status independently of delivery', () => {
    const document = widget();
    const meta = { tool: 'meta_list_ads', provider: 'meta', view: 'creatives', accountId: ad.account_id, capabilities: { can_write: true } };
    result(textResult(textResult({ ...ads, _adport: meta })));
    expect(document.querySelector('[data-creative-action]')).toBeNull();
    globals({ toolOutput: textResult(textResult(ads)), toolResponseMetadata: { adport: meta } });
    document.querySelector<HTMLButtonElement>('[data-creative-action]')!.click();
    expect(document.querySelector<HTMLSelectElement>('[data-creative-editor] select')?.value).toBe('ACTIVE');
    expect(document.querySelector('.creative-status')?.textContent).toBe('Ad set paused');
  });

  it('preserves nested error flags and scoped error metadata, including plain-text failures', () => {
    const document = widget();
    const inner = { isError: true, _meta: { adport: { tool: 'meta_set_ad_status', view: 'operation' } },
      content: [{ type: 'text', text: 'Delivery could not be confirmed <retry>.' }] };
    result({ structuredContent: textResult(inner) });
    expect(document.querySelector('h2')?.textContent).toBe('Outcome unconfirmed');
    expect(document.querySelector('[role=alert]')?.textContent).toBe('Delivery could not be confirmed <retry>.');
    expect(document.querySelector('retry,button')).toBeNull();
  });

  it('preserves provider records that have their own content field', () => {
    const payload = { name: 'A real record', ...textResult({ unrelated: true }) };
    const document = widget({ toolOutput: textResult(textResult(payload)) });
    expect(JSON.parse(document.querySelector('details pre')!.textContent!)).toEqual(payload);
  });

  it('uses the host tool name for empty Apple reports and leaves other providers on their own view', () => {
    const document = widget({ toolOutput: textResult(textResult({ result: { rows: [] } })) });
    const setTool = (name: string) => message({ method: 'ui/notifications/host-context-changed', params: { toolInfo: { tool: { name } } } });
    setTool('mcp__adport__apple_report');
    expect(document.querySelector('[data-apple-report]')?.textContent).toContain('No report rows returned.');
    setTool('other_tool');
    result(textResult(apple));
    expect(document.querySelector('[data-apple-report]')).toBeNull();
  });

  it('gives a readable error when a forwarded JSON payload was cut off', () => {
    const document = widget();
    result(textResult({ content: [{ type: 'text', text: '{"result":{"rows":[{"totalMetrics":' }] }));
    expect(document.querySelector('h2')?.textContent).toBe('Result unreadable');
    expect(document.querySelector('[role=alert]')?.textContent).toContain('could not read the complete tool response');
    expect(document.querySelector('main')?.textContent).not.toContain('totalMetrics');
  });
});
