import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ProviderCompletePage from '@/app/oauth/provider-complete/page';

describe('popup completion fallback', () => {
  it('keeps an accessible continue link when there is no initiating window', async () => {
    const html = renderToStaticMarkup(await ProviderCompletePage({ searchParams: Promise.resolve({ next: '/account-selection?selection_id=fixture' }) }));
    expect(html).toContain('Continue in this window');
    expect(html).toContain('href="/account-selection?selection_id=fixture"');
  });
  it('does not echo tokens or forward unsafe completion destinations', async () => {
    const html = renderToStaticMarkup(await ProviderCompletePage({ searchParams: Promise.resolve({ popup_id: 'invalid', next: '/dashboard/accounts?access_token=secret' }) }));
    expect(html).toContain('href="/dashboard/connections"');
    expect(html).not.toContain('secret');
  });
  it('does not label failed authorization as successful', async () => {
    const html = renderToStaticMarkup(await ProviderCompletePage({ searchParams: Promise.resolve({ next: '/dashboard/connections?error=cancelled' }) }));
    expect(html).toContain('Authorization needs attention');
  });
});
