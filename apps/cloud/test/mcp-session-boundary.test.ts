import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/proxy', () => ({ updateSession: refresh }));
import { proxy } from '@/proxy';

describe('MCP bearer authentication boundary', () => {
  beforeEach(() => { vi.resetAllMocks(); refresh.mockResolvedValue(NextResponse.next()); });

  it.each(['GET', 'POST', 'DELETE'])('passes %s to MCP authentication without browser session refresh', async method => {
    refresh.mockRejectedValue(new Error('Browser authentication unavailable'));
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
    const request = new NextRequest('https://app.adport.dev/mcp', { method, headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' }, ...(method === 'POST' ? { body } : {}) });
    const response = await proxy(request);
    expect(refresh).not.toHaveBeenCalled(); expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.has('set-cookie')).toBe(false); expect(request.headers.get('authorization')).toBe('Bearer fixture-token');
    expect(request.bodyUsed).toBe(false); if (method === 'POST') expect(await request.text()).toBe(body);
  });

  it.each(['/mcp/extra', '/mcpish', '/dashboard/agents'])('keeps browser session handling for %s', async path => {
    const request = new NextRequest(`https://app.adport.dev${path}`); await proxy(request); expect(refresh).toHaveBeenCalledExactlyOnceWith(request);
  });
});
