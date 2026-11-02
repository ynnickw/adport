import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), resolveMembership: vi.fn(), setCookie: vi.fn(),
  redirect: vi.fn((path: string): never => { throw new Error(`redirect:${path}`); }),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: mocks.setCookie }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/lib/cloud/auth', () => ({ PROJECT_COOKIE: 'adport_project' }));
vi.mock('@/lib/cloud/repository', () => ({ resolveMembership: mocks.resolveMembership, enforceRateLimit: vi.fn() }));
vi.mock('@/lib/cloud/workspaces', () => ({ createOrganization: vi.fn(), createProject: vi.fn(), updateProject: vi.fn(), renameCompany: vi.fn(), saveOrganizationMember: vi.fn(), removeCompanyMember: vi.fn() }));
vi.mock('@/lib/cloud/product-analytics', () => ({ captureProductEvent: vi.fn() }));

import { selectProjectAction } from '@/app/dashboard/projects/actions';

const projectId = 'aa000000-0000-4000-8000-000000000001';
function selection(returnTo = '/dashboard/projects') {
  const form = new FormData(); form.set('projectId', projectId); form.set('return_to', returnTo); return form;
}

describe('authorized project selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'actor' } }, error: null });
    mocks.resolveMembership.mockResolvedValue({ organizationId: projectId });
  });

  it('checks access before saving the selection and preserves the current page', async () => {
    await expect(selectProjectAction(selection())).rejects.toThrow('redirect:/dashboard/projects');
    expect(mocks.resolveMembership).toHaveBeenCalledWith('actor', projectId);
    expect(mocks.setCookie).toHaveBeenCalledWith('adport_project', projectId, expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }));
    expect(mocks.resolveMembership.mock.invocationCallOrder[0]).toBeLessThan(mocks.setCookie.mock.invocationCallOrder[0]!);
  });

  it('does not change selection when a project is unassigned or archived', async () => {
    mocks.resolveMembership.mockRejectedValue(new Error('No project access'));
    await expect(selectProjectAction(selection())).rejects.toThrow('No project access');
    expect(mocks.setCookie).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('requires a signed-in user', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(selectProjectAction(selection())).rejects.toThrow('Sign in to continue.');
    expect(mocks.resolveMembership).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });
});
