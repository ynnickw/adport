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
  const approvals: Array<{ click: () => void; fire: (name: string, event?: Record<string, unknown>) => void }> = [];
  const metrics: Array<{ dataset: { metric: string }; click: () => void }> = [];
  const planningButtons: Array<{ dataset: { planningPage: string }; disabled: boolean; click: () => void }> = [];
  let html = '';
  let renders = 0;
  const details = { open: false };
  const app = {
    get innerHTML() { return html; },
    set innerHTML(value: string) { html = value; renders++; details.open = false; },
    querySelector: (selector: string) => selector === 'details' && html.includes('<details>') ? details : null,
    querySelectorAll: (selector: string) => {
      if (selector === '[data-planning-page]') {
        planningButtons.length = 0;
        return [...app.innerHTML.matchAll(/<button[^>]*data-planning-page="(previous|next)"([^>]*)>/g)].map(match => {
          const button = { dataset: { planningPage: match[1]! }, disabled: match[2]!.includes('disabled'), click: () => {}, addEventListener: (_: string, fn: () => void) => { button.click = fn; } };
          planningButtons.push(button); return button;
        });
      }
      if (selector === '[data-metric]') {
        metrics.length = 0;
        return [...app.innerHTML.matchAll(/data-metric="([a-z]+)"/g)].map((match) => {
          const button = { dataset: { metric: match[1]! }, click: () => {}, addEventListener: (_: string, fn: () => void) => { button.click = fn; } };
          metrics.push(button);
          return button;
        });
      }
      if (selector === '[data-approve]') {
        approvals.length = 0;
        if (!app.innerHTML.includes('data-approve="true"')) return [];
        const events = new Map<string, (event: unknown) => void>();
        const button = {
          disabled: app.innerHTML.includes('disabled'), classList: { add: () => {}, remove: () => {} },
          click: () => events.get('click')?.({ detail: 0 }),
          fire: (name: string, event: Record<string, unknown> = {}) => events.get(name)?.({ type: name, preventDefault: () => {}, ...event }),
          addEventListener: (name: string, fn: (event: unknown) => void) => { events.set(name, fn); },
        };
        approvals.push(button);
        return [button];
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
    app, buttons, metrics, planningButtons, approvals, root, sent, message, details,
    globals: (globals: Record<string, unknown>) => listeners.get('openai:set_globals')?.({ detail: { globals } }),
    elapse: () => { for (const [id, fn] of [...timers]) { if (timers.delete(id)) fn(); } },
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
  it('renders exact planning amounts, unavailable values and native units without approval controls', () => {
    const ui = widget();
    ui.render('planning', { planning: { title: 'LinkedIn pricing', columns: [{ key: 'amount', label: 'Native amount' }, { key: 'missing', label: 'Unavailable' }, { key: 'unit', label: 'Unit' }], rows: [{ amount: '7.12345678', missing: null, unit: 'EUR per 1,000,000 clicks' }], notes: ['Estimates, not observed results.'] }, truncated: true });
    expect(ui.app.innerHTML).toContain('7.12345678'); expect(ui.app.innerHTML).toContain('<td>—</td>'); expect(ui.app.innerHTML).toContain('EUR per 1,000,000 clicks');
    expect(ui.app.innerHTML).toContain('Partial native response'); expect(ui.app.innerHTML).toContain('Read-only estimates'); expect(ui.app.innerHTML).not.toContain('data-approve');
  });
  it('pages planning rows locally and resets for new results without making a tool call', () => {
    const ui = widget(), planning = { title: 'Native forecast', columns: [{ key: 'metric', label: 'Metric' }], rows: Array.from({ length: 205 }, (_, i) => ({ metric: `Native row ${i}` })), notes: [] };
    ui.render('planning', { planning }); expect(ui.app.innerHTML).toContain('Rows 1–100 of 205'); expect(ui.app.innerHTML).not.toContain('<td>Native row 100</td>');
    ui.planningButtons.find(b => b.dataset.planningPage === 'previous')!.click(); expect(ui.app.innerHTML).toContain('Rows 1–100 of 205');
    ui.planningButtons.find(b => b.dataset.planningPage === 'next')!.click(); expect(ui.app.innerHTML).toContain('Rows 101–200 of 205');
    ui.planningButtons.find(b => b.dataset.planningPage === 'next')!.click(); expect(ui.app.innerHTML).toContain('Rows 201–205 of 205');
    expect(ui.planningButtons.find(b => b.dataset.planningPage === 'next')!.disabled).toBe(true);
    ui.render('planning', { planning: { ...planning, title: 'Another selection' } }); expect(ui.app.innerHTML).toContain('Rows 1–100 of 205');
    expect(ui.sent.some(v => (v as { method?: string }).method === 'tools/call')).toBe(false);
  });
  it('escapes native planning content and never reads an inherited row value', () => {
    const ui = widget(); ui.render('planning', { planning: { title: '<img src=x onerror=alert(1)>', columns: [{ key: 'constructor', label: '<script>unsafe</script>' }], rows: [{}], notes: ['<button>not an action</button>'] } });
    expect(ui.app.innerHTML).toContain('&lt;img'); expect(ui.app.innerHTML).toContain('&lt;script&gt;'); expect(ui.app.innerHTML).toContain('<td>—</td>'); expect(ui.app.innerHTML).not.toContain('function Object'); expect(ui.app.innerHTML).not.toContain('<img src=x');
  });
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
      expect(ui.app.innerHTML).toContain('<b>adport<span class="wordmark-dot" aria-hidden="true">.</span></b>');
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
    expect(ui.app.innerHTML).toContain('Action blocked');
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
        expect(ui.app.innerHTML).toContain('Action blocked');
        expect(ui.app.innerHTML).toContain('Account &lt;outside&gt; is not connected.');
      }
    }
    const ui = widget();
    ui.globals({ toolOutput: payload });
    expect(ui.app.innerHTML).toContain('Action blocked');
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
    expect(ui.app.innerHTML).toContain('Action blocked');
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

  it('shows escaped provider error text and shares an unconfirmed outcome without an apply token', async () => {
    const ui = widget();
    ui.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult('x_upload_media', 'operation', {
      status: 'pending_validation', applied: false, expires_at: '2099-01-01T00:00:00Z', pending_operation_id: 'pending-upload', preview: { summary: 'Upload QA image', changes: ['+ image'] },
    }, { arguments: { account_id: 'account', project_id: 'project', media_id: 'media' } }) } });
    ui.approvals[0]!.click();
    const request = ui.sent.at(-1) as { id: number };
    ui.message({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'PROVIDER_ERROR', message: 'X upload rejected <script>unsafe</script>' }) }] } });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(ui.app.innerHTML).toContain('X upload rejected &lt;script&gt;unsafe&lt;/script&gt;');
    expect(ui.app.innerHTML).not.toContain('<script>unsafe</script>');
    const update = ui.sent.at(-1);
    expect(update).toMatchObject({ method: 'ui/update-model-context', params: { structuredContent: { adport_operation: {
      tool: 'x_upload_media', status: 'unconfirmed', account_id: 'account', project_id: 'project',
      message: 'X upload rejected <script>unsafe</script> Check its status before retrying.',
    } } } });
    expect(JSON.stringify(update)).not.toContain('pending-upload');
    const writes = ui.sent.filter((value: unknown) => (value as { method?: string }).method === 'tools/call');
    ui.approvals[0]!.click();
    expect(ui.sent.filter((value: unknown) => (value as { method?: string }).method === 'tools/call')).toEqual(writes);
  });

  it('shares confirmed IDs and async receipts through standard host context without a consumed apply token', async () => {
    const ui = widget();
    const original = { structuredContent: structuredResult('media_get', 'data', { asset: { id: 'source-file', name: 'QA source', status: 'READY' } }) };
    ui.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: original });
    const pending = { structuredContent: structuredResult('x_upload_media', 'operation', { status: 'pending_validation', applied: false, expires_at: '2099-01-01T00:00:00Z', pending_operation_id: 'consumed-token', preview: { summary: 'Upload QA image', changes: ['+ image'] } }, { arguments: { account_id: 'a1', project_id: 'project-b' } }) };
    ui.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: pending });
    ui.approvals[0]!.click(); const request = ui.sent.at(-1) as { id: number };
    ui.message({ jsonrpc: '2.0', id: request.id, result: { structuredContent: { status: 'applied', applied: true, result: { resourceIds: ['3_123'], details: { next_tool: 'x_media_upload_status', resource_receipt: 'signed-resource-proof' } }, preview: { summary: 'Upload finalized' } } } });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(ui.app.innerHTML).toContain('3_123');
    const context = ui.sent.find((value: any) => value.method === 'ui/update-model-context');
    expect(context).toMatchObject({ params: { structuredContent: { adport_operation: { tool: 'x_upload_media', status: 'applied', project_id: 'project-b', account_id: 'a1', resource_ids: ['3_123'], next_tool: 'x_media_upload_status', resource_receipt: 'signed-resource-proof' } } } });
    expect(JSON.stringify(context)).not.toContain('consumed-token'); expect(ui.sent.filter((value: any) => value.method === 'tools/call')).toHaveLength(1);
    for (const stale of [pending,original]) ui.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: stale });
    expect(ui.app.innerHTML).toContain('>Applied</span>'); expect(ui.app.innerHTML).toContain('3_123'); expect(ui.app.innerHTML).not.toContain('Hold to apply');
  });

  it.each([false, true])('renders partial-write warnings and shares them through the host context (ChatGPT bridge=%s)', async native => {
    const warnings = ['Only 1 of 2 rows was confirmed; inspect failed rows <script>unsafe</script>'];
    const outcome = { status: 'applied', applied: true, preview: { summary: 'Upload conversion records', changes: ['+ conversion records'] }, result: { resourceIds: ['conversion-action'], details: { status: 'PARTIAL_OR_UNCONFIRMED' }, warnings } };
    const states: unknown[] = [], calls: unknown[] = [];
    const ui = widget(native ? { callTool: async (...args: unknown[]) => { calls.push(args); return { structuredContent: outcome }; }, setWidgetState: (value: unknown) => { states.push(value); } } : undefined);
    ui.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult('google_upload_click_conversions', 'operation', { status: 'pending_validation', applied: false, expires_at: '2099-01-01T00:00:00Z', pending_operation_id: 'consumed-conversion-token', preview: { summary: 'Upload conversion records', changes: ['+ conversion records'] } }, { arguments: { account_id: '123', project_id: 'project-b', conversions: [{ gclid: 'private-click-id' }] } }) } });
    ui.approvals[0]!.click();
    if (!native) {
      const request = ui.sent.at(-1) as { id: number };
      ui.message({ jsonrpc: '2.0', id: request.id, result: { structuredContent: outcome } });
    }
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(ui.app.innerHTML).toContain('Applied with warnings');
    expect(ui.app.innerHTML).toContain('role="alert"');
    expect(ui.app.innerHTML).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    expect(ui.app.innerHTML).not.toContain('<script>unsafe</script>');
    expect(ui.app.innerHTML).not.toContain('Hold to apply');
    const context = native ? states[0] : ui.sent.find((value: any) => value.method === 'ui/update-model-context');
    expect(JSON.stringify(context)).toContain('Only 1 of 2');
    expect(JSON.stringify(context)).not.toMatch(/consumed-conversion-token|private-click-id/);
    expect(native ? calls : ui.sent.filter((value: any) => value.method === 'tools/call')).toHaveLength(1);
  });

  it.each([false, true])('distinguishes async acceptance from processed conversions in both widget bridges (ChatGPT=%s)', async native => {
    const outcome = { status: 'applied', applied: true, preview: { summary: 'Ingest conversion events', changes: ['+ conversion events'] }, result: { resourceIds: ['conversion-action'], details: { status: 'ACCEPTED_FOR_PROCESSING', processed: false, next_tool: 'google_conversion_request_status', resource_receipt: 'signed-status-receipt' } } };
    const states: unknown[] = [];
    const ui = widget(native ? { callTool: async () => ({ structuredContent: outcome }), setWidgetState: (value: unknown) => { states.push(value); } } : undefined);
    ui.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult('google_ingest_conversion_events', 'operation', { status: 'pending_validation', applied: false, expires_at: '2099-01-01T00:00:00Z', pending_operation_id: 'consumed-event-token', preview: { summary: 'Ingest conversion events', changes: ['+ conversion events'] } }, { arguments: { account_id: '123', project_id: 'project-b', events: [{ transaction_id: 'private-transaction' }] } }) } });
    ui.approvals[0]!.click();
    if (!native) { const request = ui.sent.at(-1) as { id: number }; ui.message({ jsonrpc: '2.0', id: request.id, result: { structuredContent: outcome } }); }
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(ui.app.innerHTML).toContain('Processing pending');
    expect(ui.app.innerHTML).toContain('Processing is not confirmed');
    expect(ui.app.innerHTML).not.toContain('Applied.'); expect(ui.app.innerHTML).not.toContain('Hold to apply');
    const context = native ? states[0] : ui.sent.find((value: any) => value.method === 'ui/update-model-context');
    expect(JSON.stringify(context)).toContain('"processing_status":"ACCEPTED_FOR_PROCESSING","processed":false');
    expect(JSON.stringify(context)).toContain('signed-status-receipt');
    expect(JSON.stringify(context)).not.toMatch(/consumed-event-token|private-transaction/);
  });

  it('shows upload eligibility notes even when the preview has no editable before/after fields', () => {
    const ui = widget();
    ui.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult('google_upload_click_conversions', 'operation', { pending_operation_id: 'preview-only', preview: { summary: 'Upload conversion records', changes: ['+ 2 records'], notes: ['Legacy click imports are restricted; new integrations require Data Manager.'] } }) } });
    expect(ui.app.innerHTML).toContain('Legacy click imports are restricted; new integrations require Data Manager.');
    expect(ui.app.innerHTML).not.toContain('Applied.');
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
