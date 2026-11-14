import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';

const PROJECT = 'b310e750-d001-4427-8184-09bd05920e01', ACCOUNT = '551000001';
const row = (id: number) => ({ id: String(id), name: `QA form ${id}`, status: 'DRAFT' });
function page(start: number, rows = [row(start + 1), row(start + 2)], next?: number, account = ACCOUNT) {
  const args = { project_id: PROJECT, account_id: account, start, count: 2 };
  return structuredResult('linkedin_lead_forms', 'records', { records: rows, truncated: next !== undefined }, undefined, { project_id: PROJECT }, { can_write: false }, { arguments: args }, next === undefined ? undefined : { arguments: { ...args, start: next } }, { provider: 'linkedin', accountId: account, pagination: { cursorInput: 'start' } });
}
function send(dom: JSDOM, data: Record<string, unknown>) { dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: data } } })); }
function setup(callTool: ReturnType<typeof vi.fn>) { return new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } }); }
const button = (dom: JSDOM) => dom.window.document.querySelector<HTMLButtonElement>('[data-record-more]');
const cards = (dom: JSDOM) => dom.window.document.querySelectorAll('[data-record-list]>article');

describe('record list native paging', () => {
  it('appends without rebuilding existing cards or losing scroll, deduplicates clicks and ignores host echoes', async () => {
    let resolve!: (value: unknown) => void;
    const callTool = vi.fn(() => new Promise(done => { resolve = done; })), dom = setup(callTool);
    try {
      const initial = page(0, undefined, 2), second = page(2); send(dom, initial);
      const first = cards(dom)[0], root = dom.window.document.querySelector<HTMLElement>('[data-record-list]')!; root.scrollTop = 42;
      const more = button(dom)!; more.focus(); more.click(); more.click();
      await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1)); expect(callTool).toHaveBeenCalledWith('linkedin_lead_forms', { project_id: PROJECT, account_id: ACCOUNT, start: 2, count: 2 });
      expect(button(dom)).toBe(more); expect(dom.window.document.activeElement).toBe(more);
      send(dom, second); expect(cards(dom)).toHaveLength(2);
      resolve({ structuredContent: second }); await vi.waitFor(() => expect(cards(dom)).toHaveLength(4));
      expect(cards(dom)[0]).toBe(first); expect(root.scrollTop).toBe(42); expect(button(dom)).toBeNull();
      send(dom, second); send(dom, initial); expect(cards(dom)).toHaveLength(4); expect(cards(dom)[0]).toBe(first);
      expect(dom.window.document.querySelector('[data-record-details] summary')?.textContent).toBe('Details · 4 loaded');
    } finally { dom.window.close(); }
  });
  it.each(['account', 'project', 'filter', 'cursor', 'operation'])('rejects a mismatched %s response without replacing existing cards', async mismatch => {
    const second = page(2), meta = second._adport as Record<string, unknown>;
    if (mismatch === 'account') meta.accountId = '551000002';
    if (mismatch === 'project') meta.context = { project_id: '00000000-0000-4000-8000-000000000000' };
    if (mismatch === 'filter') (meta.refresh as { arguments: Record<string, unknown> }).arguments.count = 20;
    if (mismatch === 'cursor') (meta.refresh as { arguments: Record<string, unknown> }).arguments.start = 0;
    if (mismatch === 'operation') meta.view = 'operation';
    const callTool = vi.fn(async () => ({ structuredContent: second })), dom = setup(callTool);
    try {
      send(dom, page(0, undefined, 2)); const first = cards(dom)[0]; button(dom)!.click();
      await vi.waitFor(() => expect(dom.window.document.querySelector('[data-record-pages]')?.textContent).toContain('could not be confirmed'));
      expect(cards(dom)).toHaveLength(2); expect(cards(dom)[0]).toBe(first); expect(callTool).toHaveBeenCalledTimes(1);
    } finally { dom.window.close(); }
  });
  it('never calls a continuation whose arguments change the selection', () => {
    const initial = page(0, undefined, 2), meta = initial._adport as { next: { arguments: Record<string, unknown> } };
    meta.next.arguments.account_id = '551000002'; const callTool = vi.fn(), dom = setup(callTool);
    try { send(dom, initial); expect(button(dom)).toBeNull(); expect(cards(dom)).toHaveLength(2); expect(callTool).not.toHaveBeenCalled(); } finally { dom.window.close(); }
  });
  it('discards a late result and its later echo after switching accounts', async () => {
    let resolve!: (value: unknown) => void;
    const callTool = vi.fn(() => new Promise(done => { resolve = done; })), dom = setup(callTool), old = page(2);
    try {
      send(dom, page(0, undefined, 2)); button(dom)!.click();
      await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(1));
      send(dom, page(0, [row(100)], undefined, '551000002')); const current = cards(dom)[0];
      resolve({ structuredContent: old }); await new Promise(done => setTimeout(done, 0)); send(dom, old);
      expect(cards(dom)).toHaveLength(1); expect(cards(dom)[0]).toBe(current); expect(current?.textContent).toContain('QA form 100');
    } finally { dom.window.close(); }
  });
  it('accepts an explicitly exhausted empty final page without discarding already loaded cards', async () => {
    const callTool = vi.fn(async () => ({ structuredContent: page(2, []) })), dom = setup(callTool);
    try { send(dom, page(0, undefined, 2)); const first = cards(dom)[0]; button(dom)!.click(); await vi.waitFor(() => expect(button(dom)).toBeNull()); expect(cards(dom)).toHaveLength(2); expect(cards(dom)[0]).toBe(first); expect(dom.window.document.querySelector('[data-record-pages]')?.textContent).not.toContain('could not be confirmed'); } finally { dom.window.close(); }
  });
  it('stops a repeated set of records without automatically following another cursor', async () => {
    const callTool = vi.fn(async () => ({ structuredContent: page(2, [row(1), row(2)], 4) })), dom = setup(callTool);
    try { send(dom, page(0, undefined, 2)); const first = cards(dom)[0]; button(dom)!.click(); await vi.waitFor(() => expect(button(dom)).toBeNull()); expect(cards(dom)).toHaveLength(2); expect(cards(dom)[0]).toBe(first); expect(callTool).toHaveBeenCalledTimes(1); } finally { dom.window.close(); }
  });
  it('caps even an oversized response at 1,000 cards', async () => {
    const callTool = vi.fn(async () => ({ structuredContent: page(2, Array.from({ length: 1005 }, (_, index) => row(index + 3)), 1007) })), dom = setup(callTool);
    try {
      send(dom, page(0, undefined, 2)); const first = cards(dom)[0]; button(dom)!.click();
      await vi.waitFor(() => expect(cards(dom)).toHaveLength(1000)); expect(cards(dom)[0]).toBe(first); expect(button(dom)).toBeNull();
      expect(dom.window.document.querySelector('[data-record-pages]')?.textContent).toContain('Showing 1,000 records'); expect(callTool).toHaveBeenCalledTimes(1);
    } finally { dom.window.close(); }
  });
});
