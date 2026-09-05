import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ADPORT_UI_HTML, structuredResult, viewForTool, type AdportView } from '../src/ui.js';

// Execute the shipped iframe script, not a second implementation of its math.
function widget() {
  let receive: (event: unknown) => void = () => {};
  const buttons: Array<{ dataset: { group: string }; click: () => void }> = [];
  const app = {
    innerHTML: '',
    querySelectorAll: () => {
      buttons.length = 0;
      return [...app.innerHTML.matchAll(/data-group="(\d+)"/g)].map((match) => {
        const button = { dataset: { group: match[1]! }, click: () => {}, addEventListener: (_: string, fn: () => void) => { button.click = fn; } };
        buttons.push(button);
        return button;
      });
    },
  };
  const root = { dataset: {} as Record<string, string> };
  const sent: unknown[] = [];
  const parent = { postMessage: (message: unknown) => sent.push(message) };
  const window = { parent, addEventListener: (_: string, fn: typeof receive) => { receive = fn; } };
  runInNewContext(ADPORT_UI_HTML.match(/<script>([\s\S]+)<\/script>/)![1]!, {
    window, document: { getElementById: () => app, documentElement: root }, Intl,
  });
  const message = (data: unknown, source: unknown = parent) => receive({ data, source });
  return {
    app, buttons, root, sent, message,
    render: (view: AdportView, data: unknown, tool: string = view) => message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult(tool, view, data) } }),
  };
}

const row = (accountId: string, spend: number, currency?: string, conversionValue?: number) => ({
  provider: 'google', accountId, currency,
  entity: { level: 'campaign', id: accountId, name: `Campaign ${accountId}` },
  metrics: { spend, clicks: 10, conversions: 2, ...(conversionValue === undefined ? {} : { conversion_value: conversionValue }) },
});

describe('shipped MCP iframe', () => {
  it('separates currencies into working controls, never a mixed money total', () => {
    const ui = widget();
    ui.render('report', { rows: [row('eu', 100, 'EUR', 300), row('us', 900, 'USD', 900)] });
    expect(ui.app.innerHTML).toContain('€100.00');
    expect(ui.app.innerHTML).toContain('3.00×');
    expect(ui.app.innerHTML).not.toContain('1,000');
    ui.buttons[1]!.click();
    expect(ui.app.innerHTML).toContain('$900.00');
    expect(ui.app.innerHTML).toContain('1.00×');
    expect(ui.app.innerHTML).not.toContain('€100.00');
  });

  it('keeps unknown currencies isolated by provider AND account', () => {
    const ui = widget();
    ui.render('report', { rows: [row('same', 100), { ...row('same', 900), provider: 'meta' }] });
    expect(ui.buttons).toHaveLength(2);
    expect(ui.app.innerHTML).toContain('Currency unavailable');
    expect(ui.app.innerHTML).not.toContain('1,000');
    expect(ui.app.innerHTML).toContain('<small>ROAS</small><strong>—</strong>');
  });

  it('does not treat missing values, empty data or zero spend as zero ROAS', () => {
    const ui = widget();
    for (const rows of [[], [row('eu', 0, 'EUR', 0)], [row('eu', 100, 'EUR')], [row('eu', 100, 'EUR', 200), row('eu', 100, 'EUR')]]) {
      ui.render('report', { rows });
      expect(ui.app.innerHTML).not.toContain('0.00×');
      expect(ui.app.innerHTML).not.toContain('1.00×');
    }
    ui.render('report', { rows: [row('eu', 100, 'EUR', 0)] });
    expect(ui.app.innerHTML).toContain('0.00×');
  });

  it('shows partial/error states and escapes untrusted provider text', () => {
    const ui = widget();
    ui.render('report', { rows: [], truncated: true, errors: [{ provider: 'meta', message: '<img onerror="bad">' }] });
    expect(ui.app.innerHTML).toContain('Partial result');
    expect(ui.app.innerHTML).toContain('Report unavailable');
    expect(ui.app.innerHTML).toContain('&lt;img');
    expect(ui.app.innerHTML).not.toContain('<img');
  });

  it('does not describe unknown account status as healthy or available', () => {
    const ui = widget();
    ui.render('accounts', { accounts: [{ id: 'a', provider: 'google', status: 'UNKNOWN' }] });
    expect(ui.app.innerHTML).toContain('pill neutral');
    expect(ui.app.innerHTML).toContain('Status unavailable');
    expect(ui.app.innerHTML).not.toContain('Healthy');
  });

  it('renders nested recommendation previews and does not invent server validation', () => {
    const ui = widget();
    ui.render('operation', { result: { pending_operation_id: 'test', preview: { summary: 'A real preview', serverValidated: false } } }, 'recommendation_apply');
    expect(ui.app.innerHTML).toContain('A real preview');
    expect(ui.app.innerHTML).toContain('Nothing has been changed');
    expect(ui.app.innerHTML).toContain('not server validated');
    ui.render('operation', {});
    expect(ui.app.innerHTML).toContain('validation not reported');
  });

  it('routes non-campaign audit mutations to actual findings', () => {
    expect(viewForTool('audit_run', false)).toBe('insights');
    expect(viewForTool('recommendation_dismiss', false)).toBe('insights');
    expect(viewForTool('recommendation_apply', false)).toBe('operation');
    const ui = widget();
    ui.render('insights', { finding: { title: 'Review budget', status: 'dismissed' } });
    expect(ui.app.innerHTML).toContain('Review budget');
    expect(ui.app.innerHTML).toContain('dismissed');
  });

  it('accepts only parent messages and updates host theme/locale', () => {
    const ui = widget();
    ui.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult('accounts_list', 'accounts', { accounts: [] }) } }, {});
    expect(ui.app.innerHTML).toBe('');
    ui.message({ jsonrpc: '2.0', id: 1, result: { hostContext: { theme: 'dark', locale: 'de-DE' } } });
    ui.render('report', { rows: [row('eu', 123.45, 'EUR')] });
    expect(ui.root.dataset.theme).toBe('dark');
    expect(ui.app.innerHTML).toContain('123,45');
    ui.message({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light', locale: 'en-US' } });
    expect(ui.root.dataset.theme).toBe('light');
    expect(ui.app.innerHTML).toContain('123.45');
  });
});
