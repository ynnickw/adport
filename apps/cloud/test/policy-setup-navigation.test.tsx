import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '@adport/core';

const mocks = vi.hoisted(() => ({ tenant: vi.fn(), path: vi.fn(), redirect: vi.fn(), settings: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: mocks.redirect }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: mocks.path }) }));
vi.mock('@/lib/cloud/dashboard', () => ({ requireDashboardTenant: mocks.tenant, canAdminister: () => true }));
vi.mock('@/lib/db', () => ({ db: () => mocks.settings }));
vi.mock('@/lib/cloud/repository', () => ({ listOrganizationAdAccounts: async () => [], countPendingOperations: async () => 0 }));
vi.mock('@/lib/cloud/plans', () => ({ getOrganizationEntitlement: async () => ({ plan: { name: 'Growth', maxRetentionDays: 90, writeAccess: true } }) }));
vi.mock('@/lib/cloud/usage', () => ({ getOrganizationUsage: async () => ({}) }));
vi.mock('@/components/shell', () => ({ Shell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/project-switcher', () => ({ ProjectSwitcher: () => null }));
vi.mock('@/components/product-analytics', () => ({ ProductAnalytics: () => null }));
vi.mock('@/components/plan-usage', () => ({ SidebarPlanUsage: () => null }));
import PoliciesPage from '@/app/dashboard/policies/page';
import DashboardLayout from '@/app/dashboard/layout';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant.mockResolvedValue({ organizationId: 'project', organizationName: 'Client', userId: 'owner', role: 'owner', onboardingCompletedAt: null, projects: [] });
  mocks.path.mockReturnValue('/dashboard/policies?setup=1');
  mocks.settings.mockResolvedValue([{ policy: DEFAULT_POLICY, dataRetentionDays: 30 }]);
  mocks.redirect.mockImplementation(() => { throw new Error('redirect'); });
});

describe('policy customization during onboarding', () => {
  it('allows the policy page before setup is completed', async () => {
    const html = renderToStaticMarkup(await DashboardLayout({ children: <p>Policy settings</p> }));
    expect(html).toContain('Policy settings');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each(['/dashboard/projects', '/dashboard/organization'])('allows workspace management at %s before setup is completed', async path => {
    mocks.path.mockReturnValue(path);
    const html = renderToStaticMarkup(await DashboardLayout({ children: <p>Workspace settings</p> }));
    expect(html).toContain('Workspace settings');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('still guides unfinished projects into setup from the dashboard', async () => {
    mocks.path.mockReturnValue('/dashboard');
    await expect(DashboardLayout({ children: null })).rejects.toThrow('redirect');
    expect(mocks.redirect).toHaveBeenCalledWith('/onboarding?return_to=%2Fdashboard');
  });

  it('returns to setup without losing the intended dashboard destination', async () => {
    const html = renderToStaticMarkup(await PoliciesPage({ searchParams: Promise.resolve({ setup: '1', return_to: '/dashboard/agents' }) }));
    expect(html).toContain('Client policy');
    expect(html).toContain('Back to setup');
    expect(html).toContain('href="/onboarding?resume=1&amp;return_to=%2Fdashboard%2Fagents"');
  });

  it('never carries an external return destination into setup', async () => {
    const html = renderToStaticMarkup(await PoliciesPage({ searchParams: Promise.resolve({ setup: '1', return_to: 'https://untrusted.test' }) }));
    expect(html).toContain('href="/onboarding?resume=1&amp;return_to=%2Fdashboard"');
    expect(html).not.toContain('untrusted.test');
  });
});
