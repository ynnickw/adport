import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { apiError } from '@/lib/http';

const mocks = vi.hoisted(() => ({ user: vi.fn(), membership: vi.fn(), plan: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.user } }) }));
vi.mock('@/lib/cloud/repository', () => ({ resolveMembership: mocks.membership, authenticateApiKey: vi.fn(), enforceRateLimit: vi.fn() }));
vi.mock('@/lib/cloud/mcp-oauth-repository', () => ({ authenticateMcpOAuthAccessToken: vi.fn(), listMcpProjects: vi.fn() }));
vi.mock('@/lib/cloud/plans', () => ({ applyPlanToPrincipal: mocks.plan }));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); mocks.plan.mockImplementation(value => value); });

describe('session authentication at API boundaries', () => {
  it.each([
    { data: { user: null }, error: null },
    { data: { user: null }, error: { message: 'Private authentication detail', status: 400 } },
    { data: { user: { id: 'invalid' } }, error: { message: 'Invalid session', status: 401 } },
  ])('returns 401 for an absent or rejected session without reading project membership %#', async response => {
    mocks.user.mockResolvedValue(response);
    const error = await sessionPrincipal('project').catch(value => value);
    const result = apiError(error);
    expect(result.status).toBe(401); expect(await result.json()).toEqual({ error: 'Authentication required.' });
    expect(mocks.membership).not.toHaveBeenCalled(); expect(mocks.plan).not.toHaveBeenCalled();
  });

  it('still resolves the verified user against the requested project before applying its plan', async () => {
    mocks.user.mockResolvedValue({ data: { user: { id: 'verified' } }, error: null });
    mocks.membership.mockResolvedValue({ organizationId: 'project', role: 'member' });
    const result = await sessionPrincipal('project');
    expect(mocks.membership).toHaveBeenCalledExactlyOnceWith('verified', 'project');
    expect(result).toMatchObject({ userId: 'verified', organizationId: 'project', role: 'member' });
    expect(mocks.plan).toHaveBeenCalledWith(result);
  });
});
