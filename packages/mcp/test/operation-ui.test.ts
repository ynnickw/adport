import { describe, expect, it } from 'vitest';
import { structuredResult } from '../src/ui.js';
import { widget } from './widget-harness.js';

const visible = (html: string) => html.replace(/<details>[\s\S]*?<\/details>/g, '');
const preview = (id = 'pending', extra: Record<string, unknown> = {}) => structuredResult('google_set_budget', 'operation', {
  status: 'pending_validation', applied: false, pending_operation_id: id, expires_at: '2026-11-04T00:15:00Z',
  preview: { summary: 'Change "Brand search" daily budget', changes: ['~ campaign demo DailyBudget 20 → 30'],
    budgetDeltas: [{ target: 'Daily budget', currency: 'USD', fromMicros: 20000000, toMicros: 30000000 }],
    serverValidated: true, ...extra },
}, { arguments: { account_id: '123', campaign_id: '456', daily_budget_micros: 30000000, project_id: 'project-1' } });
const send = (ui: ReturnType<typeof widget>, data: unknown) => ui.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: data } });
const calls = (ui: ReturnType<typeof widget>) => ui.sent.filter((value: any) => value.method === 'tools/call') as Array<{ id: number; params: { name: string; arguments: unknown } }>;
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('minimal guarded operation review', () => {
  it('keeps the Adport shell and compact values with the orange pill hold button', () => {
    const ui = widget(); send(ui, preview());
    const html = visible(ui.app.innerHTML);
    expect(html).toContain('adport<span'); expect(html).toContain('Hold to apply');
    expect(html).toContain('$20.00'); expect(html).toContain('$30.00');
    expect(html).not.toMatch(/<table|Before<|After<|Not provided|server validated|Provider validated|Expires|Nothing has been changed/);
    expect(ui.app.innerHTML).toContain('<details><summary>Details</summary>');
  });
  it('renders a create as named proposed fields and keeps policy adjustments visible', () => {
    const ui = widget(); send(ui, preview('create', { coercions: ['status coerced to PAUSED by policy'], review: {
      provider: 'x', accountId: '123', kind: 'create', title: 'Create draft', subject: 'Announcement', notices: [],
      fields: [{ label: 'Text', format: 'text', after: 'Hello from Adport' }],
    } }));
    const html = visible(ui.app.innerHTML);
    expect(html).toContain('Hello from Adport'); expect(html).toContain('PAUSED by policy');
    expect(html).toContain('logo x'); expect(html).not.toContain('Not present');
  });
  it('preserves money units and every micro without inventing a currency or previous value', () => {
    const ui = widget(); send(ui, preview('money', { changes: [], budgetDeltas: [
      { target: 'Micro change', currency: 'USD', fromMicros: 1000000, toMicros: 1000001 },
      { target: 'Unknown currency', fromMicros: 1000001, toMicros: 1000002 },
      { target: 'New budget', currency: 'EUR', toMicros: 27562500 },
      { target: 'Three decimals', currency: 'KWD', fromMicros: 1234000, toMicros: 1235000 },
    ] }));
    const html = visible(ui.app.innerHTML);
    for (const value of ['$1.00', '$1.000001', '1.000001', '1.000002', '€27.5625', '1.234', '1.235', 'account units']) expect(html).toContain(value);
    expect(html).not.toContain('Not provided');
  });
  it('renders set changes, nulls, booleans, timezones, and unknown fields without raw JSON', () => {
    const ui = widget(); send(ui, preview('fields', { review: { provider: 'meta', accountId: '123', kind: 'update', title: 'Update targeting', notices: [], fields: [
      { label: 'Countries', before: ['UK', 'FR'], after: ['UK', 'DE'] },
      { label: 'End date', after: '2026-12-07T23:59:00Z' },
      { label: 'New field', after: null }, { label: 'Enabled', after: false },
    ] } }));
    const html = visible(ui.app.innerHTML);
    for (const value of ['+ DE', '− FR', '2026-12-07T23:59:00Z', 'Not set', 'No']) expect(html).toContain(value);
    expect(html).not.toContain('+ UK'); expect(html).not.toContain('[object Object]');
  });
  it('bounds visible arrays but keeps every item and warning in the full review', () => {
    const ui = widget(); send(ui, preview('many', { changes: ['! Shared budget affects multiple campaigns'], review: {
      provider: 'google', accountId: '123', kind: 'create', title: 'Add keywords', notices: [],
      fields: [{ label: 'Keywords', after: Array.from({ length: 100 }, (_, i) => ({ text: 'keyword-'+i, match_type: 'EXACT' })) }],
    } }));
    const html = visible(ui.app.innerHTML);
    expect(html).toContain('97 more in Details'); expect(html).not.toContain('keyword-99');
    expect(ui.app.innerHTML).toContain('keyword-99'); expect(html).toContain('Shared budget affects multiple campaigns');
  });
  it('escapes every dynamic value and renders legacy JSON payloads as fields', () => {
    const ui = widget(); ui.render('operation', { preview: { changes: ['~ demo {"name":"<img src=x onerror=alert(1)>"}'] } });
    expect(visible(ui.app.innerHTML)).toContain('&lt;img'); expect(visible(ui.app.innerHTML)).not.toContain('<img');
    expect(visible(ui.app.innerHTML)).not.toContain('{&quot;name');
  });
  it.each(['google','meta','tiktok','apple','microsoft','reddit','snapchat','spotify','pinterest','linkedin','x'])('uses a real logo for %s on operation, read, and accounts views', provider => {
    const ui = widget();
    for (const view of ['operation','data','accounts'] as const) {
      const data = view === 'accounts' ? { accounts: [{ provider, id: '123', name: 'Account' }] } : view === 'operation' ? { preview: { summary: 'Change', review: { provider, fields: [], notices: [] } } } : { value: [{ id: '123' }] };
      send(ui, structuredResult(provider+'_test', view, data, undefined, undefined, undefined, undefined, undefined, { provider }));
      expect(ui.app.innerHTML).toContain('logo '+provider); expect(ui.app.innerHTML).toContain('<svg');
    }
  });
  it('applies the exact approved payload once through the host bridge', async () => {
    const ui = widget(); send(ui, preview()); ui.approvals[0]!.click();
    expect(calls(ui)).toHaveLength(1);
    const call = calls(ui)[0]!;
    expect(call.params).toEqual({ name: 'google_set_budget', arguments: { account_id: '123', campaign_id: '456', daily_budget_micros: 30000000, project_id: 'project-1', pending_operation_id: 'pending' } });
    expect(ui.app.innerHTML).toContain('Applying…');
    ui.message({ jsonrpc: '2.0', id: call.id, result: { structuredContent: { status: 'applied', applied: true, preview: { summary: 'Done', changes: [] } } } });
    await settle(); expect(visible(ui.app.innerHTML)).toContain('Applied'); expect(visible(ui.app.innerHTML)).not.toContain('Hold to apply');
    send(ui, preview()); expect(visible(ui.app.innerHTML)).not.toContain('Hold to apply');
  });
  it('uses native text-only results without a second transport write', async () => {
    const native: unknown[] = [];
    const ui = widget({ callTool: async (...args: unknown[]) => { native.push(args); return { content: [{ type: 'text', text: JSON.stringify({ status: 'applied', applied: true }) }] }; } });
    send(ui, preview()); ui.approvals[0]!.click(); await settle();
    expect(native).toHaveLength(1); expect(calls(ui)).toHaveLength(0); expect(visible(ui.app.innerHTML)).toContain('Applied');
  });
  it('cancels short, interrupted, escaped, and stale holds; a completed keyboard hold applies once', () => {
    const ui = widget();
    for (const event of ['pointerup','pointerleave','pointercancel','blur','lostpointercapture']) {
      send(ui, preview(event)); const button = ui.approvals[0]!; button.fire('pointerdown', { button: 0 }); button.fire(event); ui.elapse(1000);
    }
    send(ui, preview('escape')); const escaped = ui.approvals[0]!; escaped.fire('keydown', { key: ' ' }); escaped.fire('keydown', { key: 'Escape' }); ui.elapse(1000);
    send(ui, preview('old')); ui.approvals[0]!.fire('pointerdown', { button: 0 }); send(ui, preview('new')); ui.elapse(1000);
    expect(calls(ui)).toHaveLength(0);
    const button = ui.approvals[0]!; button.fire('keydown', { key: ' ' }); button.fire('keydown', { key: ' ', repeat: true }); ui.elapse(900); button.fire('keyup', { key: ' ' }); button.click();
    expect(calls(ui)).toHaveLength(1);
  });
  it.each([
    { expires_at: '2026-11-03T00:00:00Z' }, { expires_at: 'invalid' }, { expires_at: undefined },
    { status: 'applied', applied: true }, { status: 'partially_applied', applied: false }, { applied: true },
  ])('never offers approval for an expired, invalid, or completed result: %j', overrides => {
    const ui = widget(); send(ui, { ...preview(), ...overrides }); expect(visible(ui.app.innerHTML)).not.toContain('data-approve');
  });
  it('expires a still-open preview and prevents a hold crossing its deadline', () => {
    const ui = widget(); send(ui, { ...preview(), expires_at: '2026-11-04T00:00:00.500Z' });
    ui.approvals[0]!.fire('keydown', { key: ' ' }); ui.elapse(1000);
    expect(calls(ui)).toHaveLength(0); expect(visible(ui.app.innerHTML)).toContain('Expired');
  });
  it('blocks unbound and incomplete previews', () => {
    const ui = widget(); const data = preview(); delete (data._adport as Record<string, unknown>).approval; send(ui, data);
    expect(visible(ui.app.innerHTML)).not.toContain('data-approve');
    send(ui, preview('empty', { changes: [], budgetDeltas: [] })); expect(visible(ui.app.innerHTML)).not.toContain('data-approve');
  });
  it('keeps an uncertain outcome locked across duplicate results and unlocks a new preview', async () => {
    const ui = widget(); send(ui, preview('timeout')); ui.approvals[0]!.click(); ui.elapse(30000); await settle();
    expect(visible(ui.app.innerHTML)).toContain('Unconfirmed'); expect(ui.app.innerHTML).toContain('may have succeeded');
    send(ui, preview('timeout')); expect(visible(ui.app.innerHTML)).not.toContain('data-approve');
    send(ui, preview('fresh')); expect(visible(ui.app.innerHTML)).toContain('Hold to apply');
  });
  it('shows explicit partial outcomes without another approval or a blanket success claim', () => {
    const ui = widget(); send(ui, { ...preview(), status: 'partially_applied', applied: false, result: { succeeded: ['a'], failed: ['b'] } });
    expect(visible(ui.app.innerHTML)).toContain('Partially applied'); expect(visible(ui.app.innerHTML)).not.toContain('data-approve');
    expect(ui.app.innerHTML).toContain('succeeded'); expect(ui.app.innerHTML).toContain('failed');
  });
  it('does not let a late response replace the next preview', async () => {
    const ui = widget(); send(ui, preview('first')); ui.approvals[0]!.click(); const call = calls(ui)[0]!;
    send(ui, preview('second'));
    ui.message({ jsonrpc: '2.0', id: call.id, result: { structuredContent: { status: 'applied', applied: true } } }); await settle();
    expect(visible(ui.app.innerHTML)).toContain('Hold to apply'); expect(visible(ui.app.innerHTML)).not.toContain('>Applied<');
  });
  it.each([['PENDING_EXPIRED','Expired'],['POLICY_VIOLATION','Blocked'],['PROVIDER_ERROR','Unconfirmed']])('classifies %s without inviting another write', async (error, phase) => {
    const ui = widget(); send(ui, preview(error)); ui.approvals[0]!.click();
    ui.message({ jsonrpc: '2.0', id: calls(ui)[0]!.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error, message: 'Provider detail' }) }] } }); await settle();
    expect(visible(ui.app.innerHTML)).toContain(phase); expect(visible(ui.app.innerHTML)).not.toContain('data-approve');
  });
  it('keeps nested recommendation approvals on their original tool and finding', () => {
    const ui = widget(); send(ui, structuredResult('recommendation_apply','operation',{ result: { ...preview(), _adport: undefined } },{ arguments: { finding_id: 'finding-1' } }));
    ui.approvals[0]!.click(); expect(calls(ui)[0]!.params).toEqual({ name: 'recommendation_apply', arguments: { finding_id: 'finding-1', pending_operation_id: 'pending' } });
  });
  it.each([[], [{ id: '1', name: 'Campaign', unknown: { enabled: false } }], { data: [] }, { arbitrary: null }, null])('renders arbitrary read response shapes without an approval control: %j', value => {
    const ui = widget(); ui.render('data', { value }, 'meta_api_read');
    expect(ui.app.innerHTML).toContain('adport<span'); expect(ui.app.innerHTML).toContain('Details'); expect(ui.app.innerHTML).not.toContain('data-approve');
  });
});
