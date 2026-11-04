import { runInNewContext } from 'node:vm';
import { ADPORT_UI_HTML, structuredResult, type AdportView } from '../src/ui.js';

// Execute the shipped iframe script, not a second implementation of its math.
export function widget(initialGlobals?: Record<string, unknown>) {
  const listeners = new Map<string, (event: unknown) => void>();
  let now = Date.parse('2026-11-04T00:00:00Z');
  const timers = new Map<number, { fn: () => void; due: number }>();
  let timerId = 0;
  const buttons: Array<{ dataset: { group: string }; click: () => void }> = [];
  const approvals: Array<{ click: () => void; fire: (name: string, event?: Record<string, unknown>) => void }> = [];
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
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn: () => void, delay = 0) => { const id = ++timerId; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const message = (data: unknown, source: unknown = parent) => listeners.get('message')?.({ data, source });
  return {
    app, buttons, metrics, approvals, root, sent, message, details,
    globals: (globals: Record<string, unknown>) => listeners.get('openai:set_globals')?.({ detail: { globals } }),
    elapse: (ms = 30000) => { now += ms; for (const [id, timer] of [...timers]) { if (timer.due <= now && timers.delete(id)) timer.fn(); } },
    renderCount: () => renders,
    render: (view: AdportView, data: unknown, tool: string = view) => message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: structuredResult(tool, view, data) } }),
  };
}
