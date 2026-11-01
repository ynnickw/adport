import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { REQUEST_PATH_HEADER } from '@/lib/return-path';

const mocks = vi.hoisted(() => ({ refreshCookies: false }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: { setAll: (cookies: Array<{ name: string; value: string; options: object }>) => void } }) => ({
    auth: { getUser: async () => {
      if (mocks.refreshCookies) options.cookies.setAll([{ name: 'sb-local-session', value: 'refreshed-local-fixture', options: { path: '/' } }]);
      return { data: { user: null } };
    } },
  }),
}));
import { updateSession } from '@/lib/supabase/proxy';

describe('session proxy return-path forwarding', () => {
  beforeEach(() => { mocks.refreshCookies = false; });
  it('overwrites a spoofed destination with the real request path and query', async () => {
    const request = new NextRequest('https://app.adport.test/dashboard/billing?plan=premium&billing=annual', { headers: { [REQUEST_PATH_HEADER]: 'https://attacker.example' } });
    const response = await updateSession(request);
    expect(response.headers.get('x-middleware-request-' + REQUEST_PATH_HEADER)).toBe('/dashboard/billing?plan=premium&billing=annual');
  });
  it('preserves refreshed session cookies while forwarding the destination', async () => {
    mocks.refreshCookies = true;
    const response = await updateSession(new NextRequest('https://app.adport.test/dashboard/accounts'));
    expect(response.cookies.get('sb-local-session')?.value).toBe('refreshed-local-fixture');
    expect(response.headers.get('x-middleware-request-cookie')).toContain('sb-local-session=refreshed-local-fixture');
    expect(response.headers.get('x-middleware-request-' + REQUEST_PATH_HEADER)).toBe('/dashboard/accounts');
  });
});
