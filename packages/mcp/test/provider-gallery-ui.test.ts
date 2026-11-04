import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';

const project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0', account = 'a1';
const args = { account_id: account, project_id: project, count: 2, q: 'QA' };
const creative = (id = 'card-1', title = 'Original title') => ({ id, provider: 'x', account_id: account, name: 'QA '+id, type: 'VIDEO_WEBSITE', status: 'CARD', headlines: [title], descriptions: [], landing_urls: ['https://example.com/qa'], media: [{ type: 'video', url: 'https://video.twimg.com/'+id+'.mp4?token=first' }], actions: [{ label: 'Edit card copy', tool: 'x_update_card', arguments: { account_id: account, card_id: id, expected_configuration_hash: 'a'.repeat(64), acknowledge_shared_creative_effects: true }, fields: [{ key: 'title', label: 'Title', type: 'text', value: title, max_length: 100 }] }] });
function page(items = [creative()], next: string | undefined = 'next-page', request: Record<string, unknown> = args, canWrite = true) {
  return { structuredContent: structuredResult('x_cards', 'creatives', { creatives: items, truncated: !!next }, undefined, { project_id: String(request.project_id) }, { can_write: canWrite }, { arguments: request }, next ? { arguments: { ...request, cursor: next } } : undefined, { provider: 'x', accountId: String(request.account_id), pagination: { cursorInput: 'cursor' } }) };
}
function preview(request: Record<string, unknown>) {
  return { structuredContent: structuredResult('x_update_card', 'operation', { status: 'pending_validation', applied: false, pending_operation_id: 'pending-card-qa', expires_at: '2099-01-01T00:00:00Z', preview: { summary: 'Edit QA card', changes: ['~ title'], serverValidated: false, coercions: [], budgetDeltas: [], review: { provider: 'x', accountId: account, kind: 'update', title: 'Edit card copy', fields: [{ label: 'Title', before: 'Original title', after: request.title }], notices: ['Shared changes can affect posts and ads.'] } } }, { arguments: request }, { project_id: project }, { can_write: true }, undefined, undefined, { provider: 'x', accountId: account }) };
}
function fixture(initial = page()) {
  const callTool = vi.fn(), dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example', beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); } });
  const notify = (value: unknown) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: value } }));
  notify(initial);
  return { dom, document: dom.window.document, notify, callTool, more: () => dom.window.document.querySelector<HTMLButtonElement>('[data-provider-more]')!, edit: () => dom.window.document.querySelector<HTMLButtonElement>('[data-creative-action]')!, submit: () => dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })) };
}

describe('scoped provider gallery controls', () => {
  it('keeps editing behind a three-dot menu and preserves video, scroll and focus while opening/canceling', () => {
    const f = fixture();try {
      const player = f.document.querySelector('video')!, grid = f.document.querySelector<HTMLElement>('[data-provider-gallery]')!;player.currentTime = 9;grid.scrollTop = 80;
      expect(f.document.querySelector('form')).toBeNull();expect(f.document.querySelector('summary')!.getAttribute('aria-label')).toBe('Actions for QA card-1');
      f.edit().click();expect(f.document.querySelector('form')!.getAttribute('aria-label')).toBe('Edit card copy');expect(f.document.querySelector('video')).toBe(player);expect(player.currentTime).toBe(9);expect(grid.scrollTop).toBe(80);
      f.document.querySelector<HTMLButtonElement>('[data-editor-cancel]')!.click();expect(f.document.querySelector('form')).toBeNull();expect(f.document.activeElement).toBe(f.document.querySelector('summary'));expect(f.callTool).not.toHaveBeenCalled();
      expect(f.document.querySelector('main')!.textContent).not.toMatch(/Organize|Distribute|Upload|Select files/);
    } finally { f.dom.window.close(); }
  });
  it('sends one bound preview, ignores its host echo and returns without applying or replacing player nodes', async () => {
    const f = fixture();try {
      const player = f.document.querySelector('video')!, grid = f.document.querySelector<HTMLElement>('[data-provider-gallery]')!;player.currentTime = 9;grid.scrollTop = 80;
      f.edit().click();f.document.querySelector<HTMLInputElement>('[data-field="0"]')!.value = 'Changed copy';
      let resolve!: (value: unknown) => void;f.callTool.mockImplementationOnce(() => new Promise(done => { resolve = done; }));f.submit();f.submit();
      await vi.waitFor(() => expect(f.callTool).toHaveBeenCalledTimes(1));const [tool, request] = f.callTool.mock.calls[0]!;
      expect(tool).toBe('x_update_card');expect(request).toEqual({ account_id: account, project_id: project, card_id: 'card-1', expected_configuration_hash: 'a'.repeat(64), acknowledge_shared_creative_effects: true, title: 'Changed copy' });expect(request).not.toHaveProperty('pending_operation_id');
      f.notify(preview(request));expect(f.document.querySelector('video')).toBe(player);resolve(preview(request));
      await vi.waitFor(() => expect(f.document.querySelector('[data-approve]')).not.toBeNull());
      f.document.querySelector<HTMLButtonElement>('[aria-label="Back to creatives"]')!.click();
      expect(f.document.querySelector('video')).toBe(player);expect(f.document.querySelector('[data-provider-gallery]')).toBe(grid);expect(player.currentTime).toBe(9);expect(grid.scrollTop).toBe(80);expect(f.document.querySelector<HTMLInputElement>('[data-field="0"]')!.value).toBe('Changed copy');expect(f.callTool).toHaveBeenCalledTimes(1);
    } finally { f.dom.window.close(); }
  });
  it('applies only through the existing review, then refreshes the originating page once and retains its player', async () => {
    const f = fixture();try {
      const player = f.document.querySelector('video')!;player.currentTime = 9;
      f.callTool.mockImplementation(async (tool, request) => {
        if (tool === 'x_cards') return page([{ ...creative('card-1', 'Changed copy'), media: [{ type: 'video', url: 'https://video.twimg.com/card-1.mp4?token=renewed' }] }], undefined, request);
        if (!request.pending_operation_id) return preview(request);
        return { structuredContent: structuredResult('x_update_card', 'operation', { status: 'applied', applied: true, result: { resourceIds: ['card-1'] } }, undefined, { project_id: project }, { can_write: true }, undefined, undefined, { provider: 'x', accountId: account }) };
      });
      f.edit().click();f.document.querySelector<HTMLInputElement>('[data-field="0"]')!.value = 'Changed copy';f.submit();await vi.waitFor(() => expect(f.document.querySelector('[data-approve]')).not.toBeNull());
      f.document.querySelector<HTMLButtonElement>('[data-approve]')!.click();await vi.waitFor(() => expect(f.document.querySelector('.operation-status')?.textContent).toBe('Applied'));
      f.document.querySelector<HTMLButtonElement>('[aria-label="Back to creatives"]')!.click();await vi.waitFor(() => expect(f.document.querySelector('.creative-copy strong')?.textContent).toBe('Changed copy'));
      expect(f.document.querySelector('video')).toBe(player);expect(player.currentTime).toBe(9);expect(f.document.querySelector('form')).toBeNull();expect(f.callTool.mock.calls.map(call => call[0])).toEqual(['x_update_card', 'x_update_card', 'x_cards']);expect(f.callTool.mock.calls[1]![1].pending_operation_id).toBe('pending-card-qa');expect(f.callTool.mock.calls[2]![1]).toEqual(args);
    } finally { f.dom.window.close(); }
  });
  it('appends native pages once, preserves filters, deduplicates overlap and retains loaded media and scroll', async () => {
    const f = fixture(page([creative('first'), creative('second')]));try {
      const grid = f.document.querySelector<HTMLElement>('[data-provider-gallery]')!, player = f.document.querySelector('video')!;grid.scrollTop = 60;player.currentTime = 7;f.more().focus();
      let resolve!: (value: unknown) => void;f.callTool.mockImplementationOnce(() => new Promise(done => { resolve = done; }));f.more().click();f.more().click();await vi.waitFor(() => expect(f.callTool).toHaveBeenCalledTimes(1));
      expect(f.callTool).toHaveBeenCalledWith('x_cards', { ...args, cursor: 'next-page' });const response = page([creative('second'), creative('third')], undefined, { ...args, cursor: 'next-page' });f.notify(response);expect(f.document.querySelectorAll('article')).toHaveLength(2);resolve(response);
      await vi.waitFor(() => expect(f.document.querySelectorAll('article')).toHaveLength(3));expect(f.document.querySelector('[data-provider-gallery]')).toBe(grid);expect(f.document.querySelector('video')).toBe(player);expect(player.currentTime).toBe(7);expect(grid.scrollTop).toBe(60);expect(f.document.activeElement).toBe(grid);expect(f.more()).toBeNull();
    } finally { f.dom.window.close(); }
  });
  it.each(['offset', 'page_token', 'bookmark', 'after'])('uses the advertised %s cursor without changing other arguments', async cursorInput => {
    const value = page(), meta = value.structuredContent._adport as any;meta.pagination.cursorInput = cursorInput;meta.next.arguments = { ...args, [cursorInput]: cursorInput === 'offset' ? 2 : 'next' };
    const f = fixture(value);try {
      const request = meta.next.arguments,response = page([creative('next')], undefined, request);(response.structuredContent._adport as any).pagination.cursorInput = cursorInput;f.callTool.mockResolvedValueOnce(response);f.more().click();await vi.waitFor(() => expect(f.document.querySelectorAll('article')).toHaveLength(2));expect(f.callTool).toHaveBeenCalledWith('x_cards', request);
    } finally { f.dom.window.close(); }
  });
  it('rejects a foreign page, keeps loaded cards for an explicit read retry, and rejects a cursor cycle', async () => {
    const f = fixture();try {
      const player = f.document.querySelector('video')!;f.callTool.mockResolvedValueOnce(page([creative('foreign')], undefined, { ...args, project_id: 'foreign-project', cursor: 'next-page' }));f.more().click();await vi.waitFor(() => expect(f.document.querySelector('main')!.textContent).toContain('could not be confirmed'));expect(f.document.querySelector('video')).toBe(player);
      f.callTool.mockResolvedValueOnce(page([creative('second')], 'next-page', { ...args, cursor: 'next-page' }));f.more().click();await vi.waitFor(() => expect(f.document.querySelectorAll('article')).toHaveLength(2));expect(f.more()).toBeNull();expect(f.callTool).toHaveBeenCalledTimes(2);
    } finally { f.dom.window.close(); }
  });
  it('ignores a late page after a project/filter change', async () => {
    const f = fixture();try {
      let resolve!: (value: unknown) => void;f.callTool.mockImplementationOnce(() => new Promise(done => { resolve = done; }));f.more().click();await vi.waitFor(() => expect(f.callTool).toHaveBeenCalledTimes(1));
      f.notify(page([{ ...creative('new-project'), account_id: 'a2' }], undefined, { ...args, account_id: 'a2', project_id: 'new-project' }));resolve(page([creative('stale')], undefined, { ...args, cursor: 'next-page' }));await new Promise(done => setTimeout(done, 0));expect(f.document.querySelectorAll('article')).toHaveLength(1);expect(f.document.querySelector('.creative-name')?.textContent).toBe('QA new-project');
    } finally { f.dom.window.close(); }
  });
  it.each(['account', 'project', 'filter', 'pending'])('never follows a continuation that changes %s', mode => {
    const value = page(), next = (value.structuredContent._adport as any).next.arguments;Object.assign(next, mode === 'account' ? { account_id: 'foreign' } : mode === 'project' ? { project_id: 'foreign' } : mode === 'filter' ? { q: 'Changed' } : { pending_operation_id: 'not-a-read' });
    const f = fixture(value);try { expect(f.more()).toBeNull();expect(f.callTool).not.toHaveBeenCalled(); } finally { f.dom.window.close(); }
  });
  it('offers paging but no write controls under a read-only grant, and rejects unbound or routing-field actions', () => {
    const readonly = fixture(page([creative()], 'next-page', args, false));try { expect(readonly.more()).not.toBeNull();expect(readonly.document.querySelector('.creative-menu,form')).toBeNull(); } finally { readonly.dom.window.close(); }
    for (const mode of ['account', 'project', 'provider', 'routing-field'] as const) {
      const item = creative();if (mode === 'account') item.actions[0]!.arguments.account_id = 'foreign';if (mode === 'project') Object.assign(item.actions[0]!.arguments, { project_id: 'foreign' });if (mode === 'provider') item.actions[0]!.tool = 'meta_update_ad';if (mode === 'routing-field') item.actions[0]!.fields[0]!.key = 'project_id';
      const f = fixture(page([item], undefined));try { expect(f.document.querySelector('.creative-menu')).toBeNull();expect(f.callTool).not.toHaveBeenCalled(); } finally { f.dom.window.close(); }
    }
  });
  it('keeps an unconfirmed preview inline, preserves the form and never automatically applies or retries', async () => {
    const f = fixture();try {
      const player = f.document.querySelector('video')!;f.callTool.mockRejectedValueOnce(new Error('Interrupted'));f.edit().click();f.submit();await vi.waitFor(() => expect(f.document.querySelector('[data-editor-error]')?.textContent).toBe('Interrupted'));expect(f.document.querySelector('video')).toBe(player);expect(f.document.querySelector('[data-approve]')).toBeNull();expect(f.callTool).toHaveBeenCalledTimes(1);
    } finally { f.dom.window.close(); }
  });
  it('removes editing controls when a fresh grant becomes read-only without replacing the player', () => {
    const f = fixture();try {const player=f.document.querySelector('video')!;f.edit().click();f.notify(page([creative()], 'next-page', args, false));expect(f.document.querySelector('.creative-menu,form')).toBeNull();expect(f.document.querySelector('video')).toBe(player);expect(f.more()).not.toBeNull();expect(f.callTool).not.toHaveBeenCalled();} finally {f.dom.window.close();}
  });
  it('updates a renamed player label without restarting it for a renewed URL', () => {
    const original = creative(), f = fixture(page([original]));try {
      const player = f.document.querySelector('video')!;player.currentTime = 3;
      f.notify(page([{ ...original, name: 'Renamed card', media: [{ ...original.media[0]!, url: original.media[0]!.url.replace('first', 'renewed') }] }]));
      expect(f.document.querySelector('video')).toBe(player);expect(player.currentTime).toBe(3);expect(player.getAttribute('src')).toBe(original.media[0]!.url);expect(player.getAttribute('aria-label')).toBe('Renamed card');
    } finally { f.dom.window.close(); }
  });
});
