import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADPORT_UI_HTML, structuredResult, viewForTool, type AdportView } from '../src/ui.js';

// Execute the shipped iframe script, not a second implementation of its math.
function widget() {
  let receive: (event: unknown) => void = () => {};
  const buttons: Array<{ dataset: { group: string }; click: () => void }> = [];
  const metrics: Array<{ dataset: { metric: string }; click: () => void }> = [];
  const app = {
    innerHTML: '',
    querySelectorAll: (selector: string) => {
      if (selector === '[data-metric]') {
        metrics.length = 0;
        return [...app.innerHTML.matchAll(/data-metric="([a-z]+)"/g)].map((match) => {
          const button = { dataset: { metric: match[1]! }, click: () => {}, addEventListener: (_: string, fn: () => void) => { button.click = fn; } };
          metrics.push(button);
          return button;
        });
      }
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
    app, buttons, metrics, root, sent, message,
    render: (view: AdportView, data: unknown, tool: string = view) => message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult(tool, view, data) } }),
  };
}

const row = (accountId: string, spend: number, currency?: string, conversionValue?: number) => ({
  provider: 'google', accountId, currency,
  entity: { level: 'campaign', id: accountId, name: `Campaign ${accountId}` },
  metrics: { spend, clicks: 10, conversions: 2, ...(conversionValue === undefined ? {} : { conversion_value: conversionValue }) },
});

describe('shipped MCP iframe', () => {
  it('keeps every view compact without marketing headings or footers', () => {
    const ui = widget();
    for (const view of ['accounts', 'report', 'operation', 'insights'] as const) {
      ui.render(view, {});
      expect(ui.app.innerHTML).not.toMatch(/<h1|class="hero"|class="foot"|EVIDENCE BEFORE ACTION|Performance,|Normalized metrics/);
      expect(ui.app.innerHTML).toContain('adport.dev');
    }
  });

  it('switches the single graph between metrics without inventing time-series data', () => {
    const ui = widget();
    ui.render('report', { rows: [row('high-spend', 100, 'EUR', 200), { ...row('high-clicks', 10, 'EUR', 40), metrics: { spend: 10, clicks: 50, conversions: 9, conversion_value: 40 } }] });
    expect(ui.app.innerHTML.match(/class="bars"/g)).toHaveLength(1);
    expect(ui.app.innerHTML).toContain('<b>Spend</b>');
    ui.metrics[1]!.click();
    expect(ui.app.innerHTML).toContain('<b>Clicks</b>');
    expect(ui.app.innerHTML.indexOf('Campaign high-clicks')).toBeLessThan(ui.app.innerHTML.indexOf('Campaign high-spend'));
    ui.metrics[2]!.click();
    expect(ui.app.innerHTML).toContain('<b>Conversions</b>');
    ui.metrics[3]!.click();
    expect(ui.app.innerHTML).toContain('<b>ROAS</b>');
    expect(ui.app.innerHTML).toContain('4.00×');
    expect(ui.app.innerHTML).not.toContain('Activity</b>');
    ui.render('report', { rows: [] });
    expect(ui.app.innerHTML).not.toContain('class="kpi"');
    expect(ui.app.innerHTML).not.toContain('class="bars"');
    expect(ui.app.innerHTML).toContain('No rows returned');
  });

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

  it('uses the official Snapchat Ghost paths rather than an initials fallback', () => {
    const ui = widget();
    ui.render('accounts', { accounts: [{ id: 'demo', name: 'Snapchat demo', provider: 'snapchat', status: 'PENDING' }] });
    const official = readFileSync(new URL('../../../apps/cloud/components/snapchat-logo.tsx', import.meta.url), 'utf8');
    const paths = [...official.matchAll(/d="([^"]+)"/g)].map(match => match[1]!);
    expect(paths).toHaveLength(2);
    for (const path of paths) expect(ui.app.innerHTML).toContain(path);
    expect(ui.app.innerHTML).toContain('fill="#fff"');
    expect(ui.app.innerHTML).toContain('fill="#000"');
    expect(ui.app.innerHTML).not.toContain('>S</span>');
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

  it('shows a concise before/after status comparison with technical details collapsed', () => {
    const ui = widget();
    ui.render('operation', { pending_operation_id: 'test', preview: {
      summary: 'Set campaign "Review demo" status PAUSED → PAUSED',
      changes: ['~ campaign demo-123 status PAUSED → PAUSED'],
      serverValidated: true,
    } }, 'meta_set_campaign_status');
    const visible = ui.app.innerHTML.split('<details>')[0]!;
    expect(visible).toContain('Review demo');
    expect(visible).toContain('>Before</th>');
    expect(visible).toContain('>After</th>');
    expect(visible).toContain('<td>PAUSED</td><td class="">PAUSED</td>');
    expect(visible).not.toContain('demo-123');
    expect(visible).not.toContain('server validated');
    expect(visible).not.toContain('Set campaign');
    expect(visible).not.toContain('<h2');
    expect(ui.app.innerHTML).toContain('<details><summary>Details</summary>');
    expect(ui.app.innerHTML).not.toContain('<details open');
    expect(ui.app.innerHTML).toContain('~ campaign demo-123 status');
    expect(visible).toContain('Preview · Not applied');
  });

  it('compares authoritative budget deltas and keeps coercions visible', () => {
    const ui = widget();
    ui.render('operation', { pending_operation_id: 'test', preview: {
      summary: 'Update "Brand Search"',
      budgetDeltas: [{ target: 'Daily budget', fromMicros: 120000000, toMicros: 132000000 }],
      coercions: ['Campaign remains paused'],
    } });
    const visible = ui.app.innerHTML.split('<details>')[0]!;
    expect(visible).toContain('<td>120</td><td class="changed">132</td>');
    expect(visible).toContain('account units');
    expect(visible).toContain('Campaign remains paused');
    expect(visible).not.toContain('€');
    ui.render('operation', { preview: { budgetDeltas: [{ target: 'Daily budget', toMicros: 132000000 }] } });
    expect(ui.app.innerHTML).toContain('<td>—</td><td class="changed">132</td>');
  });

  it('never fabricates a previous value from a freeform update', () => {
    const ui = widget();
    ui.render('operation', { preview: { summary: '<img src=x>', changes: ['~ demo {"name":"new"}'] } });
    expect(ui.app.innerHTML).toContain('Before/after values were not provided');
    expect(ui.app.innerHTML).not.toContain('<table');
    expect(ui.app.innerHTML).not.toContain('<img');
    ui.render('operation', { preview: { changes: ['~ ad_group demo status → PAUSED'] } });
    expect(ui.app.innerHTML).toContain('<td>—</td><td class="changed">PAUSED</td>');
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
