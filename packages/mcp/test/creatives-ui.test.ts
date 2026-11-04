import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';

const creative = {
  id: 'private-native-id', provider: 'meta', account_id: '123', name: 'Summer creative',
  type: 'VIDEO', status: 'ACTIVE', headlines: ['A real headline'], descriptions: ['First line\n\nSecond line <literal>'],
  landing_urls: ['https://www.example.com/app?campaign=private'],
  actions: [{ label: 'Change status', tool: 'meta_set_ad_status', arguments: { account_id: '123', ad_id: 'private-native-id' },
    fields: [{ key: 'status', label: 'Status', type: 'select', value: 'ACTIVE', options: [{ label: 'Active', value: 'ACTIVE' }] }] }],
};

function widget(overrides: Record<string, unknown> = {}, canWrite = true) {
  const callTool = vi.fn(), dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example',
    beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); },
  });
  const send = vi.spyOn(dom.window.parent, 'postMessage');
  const result = structuredResult('meta_list_ads', 'creatives', { creatives: [creative], truncated: false,
    upload_page_url: 'https://app.adport.dev/dashboard/assets', upload_config: { project_id: 'project-b' }, ...overrides },
    undefined, { project_id: 'project-b' }, { can_write: canWrite }, { arguments: { account_id: '123' } }, { arguments: { cursor: 'next' } });
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent,
    data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: result } } }));
  return { dom, document: dom.window.document, callTool, send };
}

describe('view-only creative previews', () => {
  it.each([true, false])('ignores action, upload, refresh, and paging configuration with can_write=%s', canWrite => {
    const { dom, document, callTool, send } = widget({}, canWrite);
    try {
      expect(document.querySelector('form,button,input,select,textarea,details')).toBeNull();
      expect(document.querySelector('main')?.textContent).not.toMatch(/Refresh|Upload|Change status|Replace|Editing access|private-native-id|123|private/);
      expect(document.querySelector('.creative-copy')?.textContent).toContain('First line\n\nSecond line <literal>');
      expect(document.querySelector('.creative-destination')?.textContent).toBe('example.com');
      expect(document.querySelector('.creative-destination')?.getAttribute('rel')).toContain('noopener');
      expect(callTool).not.toHaveBeenCalled();
      expect(send.mock.calls.some(([message]) => message?.method === 'tools/call')).toBe(false);
    } finally { dom.window.close(); }
  });

  it.each(['google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'])('keeps %s previews branded and view-only', provider => {
    const { dom, document } = widget({ creatives: [{ ...creative, provider }] });
    try {
      expect(document.querySelector('.brand')?.textContent).toBe('adport.');
      expect(document.querySelector('.creative-heading svg')).not.toBeNull();
      expect(document.querySelector('.creative-status')?.textContent).toBe('ACTIVE');
      expect(document.querySelector('button,form,input,textarea,select')).toBeNull();
    } finally { dom.window.close(); }
  });

  it('keeps safe media viewable without autoplay or exposing unsafe URLs', () => {
    const { dom, document } = widget({ creatives: [{ ...creative, name: '<img src=x onerror=alert(1)>', media: [
      { type: 'image', url: 'https://scontent.xx.fbcdn.net/ad.jpg', alt: 'Image' },
      { type: 'video', url: 'https://scontent.xx.fbcdn.net/ad.mp4' },
      { type: 'audio', url: 'https://scontent.xx.fbcdn.net/ad.mp3' },
      { type: 'image', url: 'javascript:alert(1)' }, { type: 'image', url: 'https://user:secret@example.com/ad.jpg' },
    ], landing_urls: ['javascript:alert(1)'] }] });
    try {
      expect(document.querySelectorAll('img')).toHaveLength(1);
      expect(document.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(document.querySelector('img')?.closest('a')?.getAttribute('aria-label')).toBe('View image: Image');
      expect(document.querySelector('video')?.getAttribute('preload')).toBe('metadata');
      expect(document.querySelector('audio')?.hasAttribute('controls')).toBe(true);
      expect(document.querySelector('video')?.hasAttribute('controls')).toBe(true);
      expect(document.querySelector('[autoplay],[onerror],.creative-destination')).toBeNull();
      expect(document.querySelector('.creative-name')?.textContent).toContain('<img src=x');
      document.querySelector('img')!.dispatchEvent(new dom.window.Event('error'));
      expect(document.querySelector('.creative-placeholder')?.textContent).toBe('Preview unavailable');
      expect(document.querySelector('button')).toBeNull();
    } finally { dom.window.close(); }
  });

  it('shows empty, partial and unavailable content honestly without management controls', () => {
    const { dom, document } = widget({ truncated: true, warnings: [{ message: 'Some native previews expired' }],
      creatives: [{ ...creative, status: undefined, type: 'application/pdf', headlines: [], descriptions: [] }] });
    try {
      expect(document.querySelector('main')?.textContent).toContain('Showing 1 preview from a partial result.');
      expect(document.querySelector('main')?.textContent).toContain('Some native previews expired');
      expect(document.querySelector('.creative-status')?.textContent).toBe('Status unavailable');
      expect(document.querySelector('.creative-placeholder')?.textContent).toBe('Document preview unavailable');
      expect(document.querySelector('button,form')).toBeNull();
    } finally { dom.window.close(); }
    const empty = widget({ creatives: [] });
    try { expect(empty.document.querySelector('main')?.textContent).toContain('No creatives to preview.'); }
    finally { empty.dom.window.close(); }
  });

  it('retains every returned creative and media item in the scrollable gallery without duplicating copy', () => {
    const { dom, document } = widget({ creatives: Array.from({ length: 9 }, (_, i) => ({ ...creative,
      name: `Creative ${i + 1}`, headlines: ['A real headline', 'A real headline'], descriptions: ['A real headline', 'Actual copy', 'Actual copy'],
      media: [{ type: 'image', url: `https://example.com/${i}.jpg` }, { type: 'image', url: `https://example.com/${i}-2.jpg` }],
    })) });
    try {
      expect(document.querySelectorAll('article')).toHaveLength(9);
      expect(document.querySelectorAll('.creative-media img')).toHaveLength(18);
      expect(document.querySelector('[role="region"]')?.getAttribute('tabindex')).toBe('0');
      expect(document.querySelector('.creative-copy')?.textContent).toBe('A real headlineActual copy');
      expect(document.querySelector('button,input,select,textarea')).toBeNull();
    } finally { dom.window.close(); }
  });
});
