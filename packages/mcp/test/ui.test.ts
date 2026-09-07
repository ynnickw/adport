import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADPORT_UI_HTML, structuredResult, viewForTool, type AdportView } from '../src/ui.js';

// Execute the shipped iframe script, not a second implementation of its math.
function widget(initialGlobals?: Record<string, unknown>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const buttons: Array<{ dataset: { group: string }; click: () => void }> = [];
  const metrics: Array<{ dataset: { metric: string }; click: () => void }> = [];
  let html = '';
  let renders = 0;
  const details = { open: false };
  const app = {
    get innerHTML() { return html; },
    set innerHTML(value: string) { html = value; renders++; details.open = false; },
    querySelector: (selector: string) => selector === 'details' && html.includes('<details>') ? details : null,
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
  const window = { parent, openai: initialGlobals, addEventListener: (name: string, fn: (event: unknown) => void) => { listeners.set(name, fn); } };
  runInNewContext(ADPORT_UI_HTML.match(/<script>([\s\S]+)<\/script>/)![1]!, {
    window, document: { getElementById: () => app, documentElement: root }, Intl,
    setTimeout: (fn: () => void) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const message = (data: unknown, source: unknown = parent) => listeners.get('message')?.({ data, source });
  return {
    app, buttons, metrics, root, sent, message, details,
    globals: (globals: Record<string, unknown>) => listeners.get('openai:set_globals')?.({ detail: { globals } }),
    elapse: () => { for (const [id, fn] of timers) { timers.delete(id); fn(); } },
    renderCount: () => renders,
    render: (view: AdportView, data: unknown, tool: string = view) => message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult(tool, view, data) } }),
  };
}

const row = (accountId: string, spend: number, currency?: string, conversionValue?: number) => ({
  provider: 'google', accountId, currency,
  entity: { level: 'campaign', id: accountId, name: `Campaign ${accountId}` },
  metrics: { spend, clicks: 10, conversions: 2, ...(conversionValue === undefined ? {} : { conversion_value: conversionValue }) },
});

describe('shipped MCP iframe', () => {
  it('uses the same server summary as the agent and preserves explicit unavailable ratios', () => {
    const ui = widget();
    ui.render('report', {
      rows: [row('eur', 100, 'EUR', 200), row('usd', 50, 'USD', 200)],
      summary: { scope: 'returned_rows', complete: true, groups: [
        { key: 'EUR', metrics: { spend: 100, roas: 2 } },
        { key: 'USD', metrics: { spend: 50, roas: null } },
      ] },
    });
    expect(ui.app.innerHTML).toContain('<small>ROAS</small><strong>2.00×</strong>');
    ui.buttons[1]!.click();
    expect(ui.app.innerHTML).toContain('$50.00');
    expect(ui.app.innerHTML).toContain('<small>ROAS</small><strong>—</strong>');
  });

  it('labels synthetic results explicitly and clears the label for real results', () => {
    const ui = widget();
    ui.render('report', { data_source: 'synthetic', rows: [row('demo-eur', 100, 'EUR')] });
    expect(ui.app.innerHTML).toContain('Synthetic demo');
    ui.render('accounts', { accounts: [] });
    expect(ui.app.innerHTML).not.toContain('Synthetic demo');
  });
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

  it('renders reported ROAS without requiring an extra conversion_value metric', () => {
    const ui = widget();
    ui.render('report', { rows: [
      { ...row('search', 91, 'EUR'), metrics: { spend: 91, roas: 5.54 } },
      { ...row('discovery', 112, 'EUR'), metrics: { spend: 112, roas: 1.5 } },
      { ...row('retargeting', 133, 'EUR'), metrics: { spend: 133, roas: 6.32 } },
    ] });
    expect(ui.app.innerHTML).toContain('<small>ROAS</small><strong>4.50×</strong>');
    ui.metrics[3]!.click();
    expect(ui.app.innerHTML).toContain('6.32×');
    expect(ui.app.innerHTML).toContain('5.54×');
    expect(ui.app.innerHTML).toContain('1.50×');
    expect(ui.app.innerHTML.indexOf('Campaign retargeting')).toBeLessThan(ui.app.innerHTML.indexOf('Campaign discovery'));
  });

  it('uses spend-weighted ratios and prefers exact conversion values when present', () => {
    const ui = widget();
    ui.render('report', { rows: [
      { ...row('exact', 100, 'EUR', 200), metrics: { spend: 100, conversion_value: 200, roas: 99 } },
      { ...row('reported', 900, 'EUR'), metrics: { spend: 900, roas: 4 } },
    ] });
    expect(ui.app.innerHTML).toContain('<small>ROAS</small><strong>3.80×</strong>');
    ui.metrics[3]!.click();
    expect(ui.app.innerHTML).toContain('2.00×');
    expect(ui.app.innerHTML).not.toContain('99.00×');
  });

  it('does not merge currencies or invent weights for reported ROAS', () => {
    const ui = widget();
    ui.render('report', { rows: [
      { ...row('eu', 100, 'EUR'), metrics: { spend: 100, roas: 2 } },
      { ...row('us', 900, 'USD'), metrics: { spend: 900, roas: 4 } },
    ] });
    expect(ui.app.innerHTML).toContain('<small>ROAS</small><strong>2.00×</strong>');
    ui.buttons[1]!.click();
    expect(ui.app.innerHTML).toContain('<small>ROAS</small><strong>4.00×</strong>');
    for (const metrics of [{ roas: 4 }, { spend: 0, roas: 4 }, { spend: 100, roas: null }, { spend: 100, roas: Infinity }]) {
      ui.render('report', { rows: [{ ...row('eu', 100, 'EUR'), metrics }] });
      expect(ui.app.innerHTML).toContain('<small>ROAS</small><strong>—</strong>');
    }
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

  it('renders structured policy errors instead of a loading or success view', () => {
    const ui = widget();
    ui.render('operation', { error: 'POLICY_VIOLATION', message: 'Account <outside> is not connected.' });
    expect(ui.app.innerHTML).toContain('Request failed');
    expect(ui.app.innerHTML).toContain('Account &lt;outside&gt; is not connected.');
    expect(ui.app.innerHTML).not.toMatch(/Loading|No active recommendations|Preview · Not applied/);
  });

  it('hydrates errors from initial and late ChatGPT compatibility globals', () => {
    const payload = structuredResult('report', 'report', { error: 'POLICY_VIOLATION', message: 'Account <outside> is not connected.' });
    const envelope = { isError: true, structuredContent: payload };
    for (const key of ['mcp_tool_result', 'call_tool_result']) {
      const globals = { toolResponseMetadata: { [key]: envelope } };
      for (const ui of [widget(globals), widget()]) {
        ui.globals(globals);
        expect(ui.app.innerHTML).toContain('Request failed');
        expect(ui.app.innerHTML).toContain('Account &lt;outside&gt; is not connected.');
      }
    }
    const ui = widget();
    ui.globals({ toolOutput: payload });
    expect(ui.app.innerHTML).toContain('Request failed');
  });

  it('reads JSON content error envelopes without replacing them with stale success output', () => {
    const ui = widget({ toolOutput: structuredResult('accounts_list', 'accounts', { accounts: [] }) });
    ui.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {
      isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'DENIED', message: '<blocked>' }) }],
    } });
    expect(ui.app.innerHTML).toContain('Request failed');
    expect(ui.app.innerHTML).toContain('&lt;blocked&gt;');
    expect(ui.app.innerHTML).not.toContain('0 accounts');
  });

  it('handles cancellation honestly without claiming execution succeeded or nothing changed', () => {
    const ui = widget();
    ui.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-cancelled', params: { reason: '<timeout>' } });
    expect(ui.app.innerHTML).toContain('Request interrupted');
    expect(ui.app.innerHTML).toContain('&lt;timeout&gt;');
    expect(ui.app.innerHTML).not.toMatch(/Loading|Nothing has been changed|Not applied/);
    ui.render('accounts', { accounts: [] });
    expect(ui.app.innerHTML).not.toContain('Request interrupted');
  });

  it('replaces indefinite loading with an honest delivery fallback and accepts a late result', () => {
    const ui = widget();
    ui.elapse();
    expect(ui.app.innerHTML).toContain('Result not received');
    expect(ui.app.innerHTML).toContain('Check the tool response');
    expect(ui.app.innerHTML).not.toMatch(/Request failed|Nothing has been changed|Loading/);
    ui.render('accounts', { accounts: [] });
    expect(ui.app.innerHTML).toContain('0 accounts');
    expect(ui.app.innerHTML).not.toContain('Result not received');
  });

  it('does not overwrite received results with the delivery timeout', () => {
    const ui = widget();
    ui.render('report', { error: 'POLICY_VIOLATION', message: 'Not connected.' });
    ui.elapse();
    expect(ui.app.innerHTML).toContain('Request failed');
    expect(ui.app.innerHTML).not.toContain('Result not received');
  });

  it('ignores duplicate compatibility hydration and context-only globals', () => {
    const ui = widget();
    const payload = structuredResult('meta_set_campaign_status', 'operation', { preview: { summary: 'Review', changes: [] } });
    ui.globals({ toolOutput: payload });
    ui.details.open = true;
    const count = ui.renderCount();
    ui.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: payload } });
    ui.globals({ theme: 'dark' });
    ui.globals({ toolOutput: null });
    expect(ui.renderCount()).toBe(count);
    expect(ui.details.open).toBe(true);
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

  it('shows Applied rather than preview after a successful no-op apply', () => {
    const ui = widget();
    ui.render('operation', { status: 'applied', applied: true, preview: {
      summary: 'Set campaign "Review demo" status PAUSED → PAUSED',
      changes: ['~ campaign demo-123 status PAUSED → PAUSED'],
      serverValidated: true,
    } }, 'meta_set_campaign_status');
    const visible = ui.app.innerHTML.split('<details>')[0]!;
    expect(visible).toContain('Applied');
    expect(visible).not.toContain('Preview');
    expect(visible).toContain('<td>PAUSED</td><td class="">PAUSED</td>');
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

  it('formats budget comparisons only with provider-reported currency', () => {
    const ui = widget();
    ui.render('operation', { preview: { budgetDeltas: [
      { target: 'Daily budget', currency: 'EUR', fromMicros: 25000000, toMicros: 26250000 },
      { target: 'US budget', currency: 'USD', toMicros: 20000000 },
      { target: 'Unknown budget', currency: '<invalid>', fromMicros: 1000000, toMicros: 2000000 },
    ] } });
    expect(ui.app.innerHTML).toContain('Daily budget · EUR');
    expect(ui.app.innerHTML).toContain('<td>€25.00</td><td class="changed">€26.25</td>');
    expect(ui.app.innerHTML).toContain('<td>—</td><td class="changed">$20.00</td>');
    expect(ui.app.innerHTML).toContain('Unknown budget (account units)');
    expect(ui.app.innerHTML).toContain('<td>1</td><td class="changed">2</td>');
  });

  it('preserves micros in before/after amounts instead of rounding away the proposed change', () => {
    const ui = widget();
    ui.render('operation', { preview: { budgetDeltas: [
      { target: 'Daily budget', currency: 'EUR', fromMicros: 26250000, toMicros: 27562500 },
      { target: 'Micro change', currency: 'USD', fromMicros: 1000000, toMicros: 1000001 },
      { target: 'Unknown currency', fromMicros: 1000001, toMicros: 1000002 },
      { target: 'Three decimals', currency: 'KWD', fromMicros: 1234000, toMicros: 1235000 },
    ] } });
    const visible = ui.app.innerHTML.split('<details>')[0]!;
    expect(visible).toContain('<td>€26.25</td><td class="changed">€27.5625</td>');
    expect(visible).toContain('<td>$1.00</td><td class="changed">$1.000001</td>');
    expect(visible).toContain('<td>1.000001</td><td class="changed">1.000002</td>');
    expect(visible).toContain('1.234');
    expect(visible).toContain('1.235');
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

  it('keeps Details open when the host echoes iframe size or changes theme/locale', () => {
    const ui = widget();
    ui.render('operation', { pending_operation_id: 'test', preview: { summary: 'Review demo' } });
    ui.details.open = true;
    const renders = ui.renderCount();
    for (const params of [{ containerDimensions: { width: 768, height: 420 } }, { theme: 'dark' }]) {
      ui.message({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params });
      expect(ui.details.open).toBe(true);
      expect(ui.renderCount()).toBe(renders);
    }
    ui.message({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { locale: 'de-DE' } });
    expect(ui.renderCount()).toBe(renders + 1);
    expect(ui.details.open).toBe(true);
    ui.render('operation', { pending_operation_id: 'new', preview: { summary: 'New preview' } });
    expect(ui.details.open).toBe(false);
  });
});
