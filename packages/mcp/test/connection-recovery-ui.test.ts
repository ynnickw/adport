import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';

const project = 'b310e750-d001-4427-8184-09bd05920e01';
const args = { project_id: project, account_id: '1', container_id: '2', version_id: '4', expected_fingerprint: 'reviewed', expected_live_version_id: '3' };
const preview = (pending: string, arguments_ = args) => ({ structuredContent: structuredResult('gtm_publish_version', 'operation', {
  status: 'pending_validation', applied: false, pending_operation_id: pending, expires_at: '2099-01-01T00:00:00Z',
  preview: { summary: 'Publish reviewed QA version', changes: ['Publish complete version 4, replacing live version 3.'], review: { fields: [{ label: 'Version', after: '4' }] } },
}, { arguments: arguments_ }, { project_id: project }) });
const failure = (extra = {}) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'NOT_CONNECTED', message: 'Finish account selection. No write was started.', details: {
  apply_state: 'NOT_STARTED', connection_recovery: { kind: 'account_selection', project_id: project, dashboard_url: 'https://app.adport.dev/dashboard/analytics' }, ...extra,
} }) }] });

function mount(native: boolean, call: (name: string, args: unknown) => Promise<unknown>) {
  const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example.test', beforeParse(window) {
    if (native) Object.defineProperty(window, 'openai', { value: { callTool: call, notifyIntrinsicHeight() {} } });
  } });
  const send = (data: unknown) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data }));
  if (!native) dom.window.parent.postMessage = message => {
    if (message?.method === 'tools/call') void call(message.params.name, message.params.arguments).then(result => send({ jsonrpc: '2.0', id: message.id, result }));
  };
  send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: preview('original') });
  return dom;
}

describe('connection recovery never replays a write', () => {
  it.each([false, true])('requires a user-triggered fresh preview and another approval (OpenAI=%s)', async native => {
    const call = vi.fn().mockResolvedValueOnce(failure()).mockResolvedValueOnce(preview('fresh')).mockResolvedValueOnce({ structuredContent: { status: 'applied', applied: true, result: { resourceIds: ['version-4'] } } });
    const dom = mount(native, call);
    try {
      (dom.window.document.querySelector('[data-approve]') as HTMLElement).click();
      await vi.waitFor(() => expect(dom.window.document.querySelector('[data-refresh-preview]')).not.toBeNull());
      expect(call).toHaveBeenCalledTimes(1); expect(call.mock.calls[0]).toEqual(['gtm_publish_version', { ...args, pending_operation_id: 'original' }]);
      expect(dom.window.document.getElementById('app')?.textContent).toContain('No write was started');
      expect(dom.window.document.querySelector('a')?.getAttribute('href')).toBe('https://app.adport.dev/dashboard/analytics');
      (dom.window.document.querySelector('[data-refresh-preview]') as HTMLElement).click();
      await vi.waitFor(() => expect(dom.window.document.querySelector('[data-approve]')).not.toBeNull());
      expect(call).toHaveBeenCalledTimes(2); expect(call.mock.calls[1]).toEqual(['gtm_publish_version', args]);
      expect(dom.window.document.getElementById('app')?.textContent).not.toContain('Applied');
      (dom.window.document.querySelector('[data-approve]') as HTMLElement).click();
      await vi.waitFor(() => expect(dom.window.document.querySelector('.operation-status')?.textContent).toBe('Applied'));
      expect(call).toHaveBeenCalledTimes(3); expect(call.mock.calls[2]).toEqual(['gtm_publish_version', { ...args, pending_operation_id: 'fresh' }]);
    } finally { dom.window.close(); }
  });
  it.each([
    { apply_state: 'UNCONFIRMED' },
    { connection_recovery: { kind: 'account_selection', project_id: 'another-project', dashboard_url: 'https://app.adport.dev/dashboard/analytics' } },
    { connection_recovery: { kind: 'account_selection', project_id: project, dashboard_url: 'javascript:alert(1)' } },
  ])('offers no retry when execution or recovery scope is uncertain: %j', async details => {
    const call = vi.fn().mockResolvedValue(failure(details)); const dom = mount(false, call);
    try {
      (dom.window.document.querySelector('[data-approve]') as HTMLElement).click();
      await vi.waitFor(() => expect(dom.window.document.querySelector('.operation-status')?.textContent).toBe('Blocked'));
      expect(dom.window.document.querySelector('[data-refresh-preview]')).toBeNull(); expect(call).toHaveBeenCalledTimes(1);
    } finally { dom.window.close(); }
  });
  it('rejects a refreshed preview that changes the reviewed arguments', async () => {
    const call = vi.fn().mockResolvedValueOnce(failure()).mockResolvedValueOnce(preview('fresh', { ...args, version_id: '999' })); const dom = mount(false, call);
    try {
      (dom.window.document.querySelector('[data-approve]') as HTMLElement).click();
      await vi.waitFor(() => expect(dom.window.document.querySelector('[data-refresh-preview]')).not.toBeNull());
      (dom.window.document.querySelector('[data-refresh-preview]') as HTMLElement).click();
      await vi.waitFor(() => expect(dom.window.document.getElementById('app')?.textContent).toContain('could not be matched'));
      expect(dom.window.document.querySelector('[data-approve]')).toBeNull(); expect(call).toHaveBeenCalledTimes(2);
    } finally { dom.window.close(); }
  });
});
