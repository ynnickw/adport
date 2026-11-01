import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/proxy', () => ({ updateSession: refresh }));
import { proxy } from '@/proxy';

describe('public support session boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    refresh.mockResolvedValue(NextResponse.next());
  });

  it('serves the public contact route without depending on session refresh', async () => {
    refresh.mockRejectedValue(new Error('Authentication service unavailable'));
    const response = await proxy(new NextRequest('https://app.adport.dev/api/public-support'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(['/dashboard', '/api/support', '/api/public-support/extra', '/api/public-supportish'])('retains session handling on %s', async path => {
    const request = new NextRequest(`https://app.adport.dev${path}`);
    await proxy(request);
    expect(refresh).toHaveBeenCalledWith(request);
  });
});
