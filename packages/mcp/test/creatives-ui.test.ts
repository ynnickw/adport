import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult } from '../src/ui.js';
import { XAdsClient, XAdsProvider } from '@adport/provider-x';

const creative = {
  id: '33', provider: 'google', account_id: '1234567890', name: '<img src=x onerror=alert(1)>',
  type: 'RESPONSIVE_SEARCH_AD', status: 'PAUSED', headlines: ['A real headline'], descriptions: ['Ad description'],
  actions: [{ label: 'Change status', tool: 'google_set_ad_status',
    arguments: { account_id: '1234567890', ad_group_id: '22', ad_id: '33' },
    fields: [{ key: 'status', label: 'Status', type: 'select', value: 'PAUSED', options: [{ label: 'Paused', value: 'PAUSED' }, { label: 'Enabled', value: 'ENABLED' }] }],
  }],
};

function widget(callTool?: (...args: unknown[]) => Promise<unknown>, overrides: Record<string, unknown> = {}) {
  const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example',
    beforeParse(window) {
      if (callTool) Object.defineProperty(window, 'openai', { value: { callTool } });
    },
  });
  const result = structuredResult('google_ads', 'creatives', { creatives: [creative], truncated: false, ...overrides }, undefined, { project_id: 'project-b' });
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: result } } }));
  return dom;
}

describe('creative widget editor', () => {
  it('keeps read-only connections in a view without editable forms', () => {
    const dom = widget();
    try {
      const result = structuredResult('google_ads', 'creatives', { creatives: [creative], truncated: false }, undefined, undefined, { can_write: false });
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: result } } }));
      expect(dom.window.document.querySelector('form')).toBeNull();
      expect(dom.window.document.querySelector('main')?.textContent).toContain('Editing access is required');
    } finally { dom.window.close(); }
  });
  it('renders image/video/audio safely and opens the scoped library through the host bridge', () => {
    const dom = widget(undefined, { upload_page_url: 'https://app.adport.dev/dashboard/assets?project_id=project-b', creatives: [{ ...creative, media: [
      { type: 'image', url: 'https://scontent.xx.fbcdn.net/ad.jpg', alt: 'Image' },
      { type: 'video', url: 'https://scontent.xx.fbcdn.net/ad.mp4' },
      { type: 'audio', url: 'https://scontent.xx.fbcdn.net/ad.mp3' },
      { type: 'image', url: 'javascript:alert(1)' },
    ] }] });
    try {
      const document = dom.window.document;
      expect(document.querySelectorAll('img')).toHaveLength(1);
      expect(document.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(document.querySelector('video')?.getAttribute('preload')).toBe('none');
      expect(document.querySelector('audio')?.hasAttribute('controls')).toBe(true);
      expect(document.querySelector('[autoplay]')).toBeNull();
      const send = vi.spyOn(dom.window.parent, 'postMessage');
      (document.querySelector('[data-open-library]') as HTMLButtonElement).click();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ method: 'ui/open-link', params: { url: 'https://app.adport.dev/dashboard/assets?project_id=project-b' } }), '*');
    } finally { dom.window.close(); }
  });
  it('renders real ad text safely and previews a scoped edit without applying it', async () => {
    const calls: unknown[][] = [];
    const dom = widget(async (...args) => {
      calls.push(args);
      return { structuredContent: { status: 'pending_validation', applied: false, pending_operation_id: 'pending',
        preview: { summary: 'Set ad 33 status PAUSED → ENABLED', changes: ['~ ad 33 status PAUSED → ENABLED'], coercions: [], budgetDeltas: [], serverValidated: true } } };
    });
    try {
      const { document } = dom.window;
      expect(document.querySelector('.creative-copy')?.textContent).toContain('A real headline');
      expect(document.querySelector('img')).toBeNull();
      const select = document.querySelector('select')!;
      select.value = 'ENABLED';
      document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(calls).toEqual([['google_set_ad_status', { account_id: '1234567890', ad_group_id: '22', ad_id: '33', project_id: 'project-b', status: 'ENABLED' }]]);
      expect(document.body.textContent).toContain('Preview');
      expect(document.body.textContent).toContain('Hold to apply');
      expect(document.querySelector('form')).toBeNull();
    } finally { dom.window.close(); }
  });

  it('uses the standard MCP Apps bridge on hosts without the ChatGPT extension', async () => {
    const dom = widget();
    const calls: unknown[] = [];
    dom.window.parent.postMessage = ((message: unknown) => { calls.push(message); }) as typeof dom.window.parent.postMessage;
    try {
      dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      expect(calls).toEqual([expect.objectContaining({ method: 'tools/call', params: {
        name: 'google_set_ad_status', arguments: { account_id: '1234567890', ad_group_id: '22', ad_id: '33', project_id: 'project-b', status: 'PAUSED' },
      } })]);
    } finally { dom.window.close(); }
  });

  it('preserves multiline Reddit copy and stages only a project/account-bound preview', async () => {
    const calls: unknown[][] = [], originalBody = 'First line\n\nSecond line <literal>';
    const dom = widget(async (...args) => { calls.push(args); return { structuredContent: { status: 'pending_validation', applied: false, pending_operation_id: 'pending', preview: { summary: 'Stage a new post copy', changes: ['Original post and ad reference remain unchanged'], coercions: [], budgetDeltas: [], serverValidated: false } } }; }, { creatives: [{ ...creative, provider: 'reddit', account_id: 'a2_test', actions: [{ label: 'Stage a creative copy', tool: 'reddit_stage_post_copy', arguments: { account_id: 'a2_test', ad_id: 'ad-1', source_post_id: 't3_source', profile_id: 'profile-1' }, fields: [{ key: 'headline', label: 'Headline', type: 'text', value: 'Headline' }, { key: 'body', label: 'Body', type: 'text', value: originalBody }] }] }] });
    try {
      const fields = dom.window.document.querySelectorAll('textarea'); expect(fields[1]!.value).toBe(originalBody); fields[0]!.value = 'Edited headline';
      dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(calls).toEqual([['reddit_stage_post_copy', { account_id: 'a2_test', ad_id: 'ad-1', source_post_id: 't3_source', profile_id: 'profile-1', project_id: 'project-b', headline: 'Edited headline', body: originalBody }]]);
      expect(dom.window.document.querySelector('main')?.textContent).toContain('Hold to apply'); expect(dom.window.document.querySelector('main')?.textContent).not.toContain('Applied.');
    } finally { dom.window.close(); }
  });

  it('keeps a rejected preview editable and never claims it was applied', async () => {
    const dom = widget(async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'POLICY_VIOLATION', message: 'Protected account' }) }] }));
    try {
      dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toBe('Protected account');
      expect(dom.window.document.querySelector('main')?.textContent).not.toContain('Applied.');
      expect(dom.window.document.querySelector('form button')?.hasAttribute('disabled')).toBe(false);
    } finally { dom.window.close(); }
  });

  it('renders provider-generated X draft media and previews copy without renaming an unnamed draft', async () => {
    const draftId = '994747471329873920', mediaKey = '3_908573900237180928', copy = 'First line\n\nNext line';
    const provider = new XAdsProvider(new XAdsClient({ consumerKey: 'key', consumerSecret: 'secret', accessToken: 'access', accessTokenSecret: 'access-secret' }, async url => {
      const path = new URL(String(url)).pathname;
      return Response.json({ data: path.endsWith('/draft_tweets') ? [{ id: draftId, user_id: '756201191646691328', text: copy, name: null, nullcast: true, card_uri: null, media_keys: [mediaKey] }] : path.endsWith(`/media_library/${mediaKey}`) ? { media_key: mediaKey, media_type: 'IMAGE', media_status: 'TRANSCODE_COMPLETED', media_url: 'https://pbs.twimg.com/media/image.jpg', deleted: false } : { id: 'a1', name: 'Account', timezone: 'UTC', approval_status: 'ACCEPTED', deleted: false }, next_cursor: null });
    }));
    const result = await provider.creatives.drafts({ account_id: 'a1' }), calls: unknown[][] = [];
    const dom = widget(async (...args) => { calls.push(args); return { structuredContent: { status: 'pending_validation', applied: false, pending_operation_id: 'x-pending', preview: { summary: 'Edit native draft', changes: ['No publication'], coercions: [], budgetDeltas: [], serverValidated: false } } }; }, result);
    try {
      const document = dom.window.document;
      expect(document.querySelector('img')?.src).toBe('https://pbs.twimg.com/media/image.jpg');
      const text = document.querySelector('textarea')!; expect(text.value).toBe(copy); text.value = 'Edited\n\nCopy';
      document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 10));
      expect(calls).toEqual([['x_update_draft_tweet', { account_id: 'a1', draft_tweet_id: draftId, project_id: 'project-b', text: 'Edited\n\nCopy' }]]);
      expect(document.querySelector('main')?.textContent).toContain('Hold to apply'); expect(document.querySelector('main')?.textContent).not.toContain('Applied.');
    } finally { dom.window.close(); }
  });
});
