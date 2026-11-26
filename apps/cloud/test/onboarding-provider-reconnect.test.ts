import { Children, createElement, isValidElement, type ComponentProps, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { ConnectionView } from '@/app/dashboard/connections/provider-connections';

const mocks = vi.hoisted(() => ({
  connections: vi.fn(),
  accounts: vi.fn(async (): Promise<unknown[]> => []),
  state: vi.fn(async () => ({ currentStep: 'connect' })),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/cloud/account-selection', () => ({ getAccountSelection: vi.fn() }));
vi.mock('@/lib/cloud/dashboard', () => ({ canAdminister: () => true, requireDashboardTenant: async () => ({ organizationId: 'project', userId: 'owner', organizationRole: 'owner', projects: [] }) }));
vi.mock('@/lib/cloud/onboarding', () => ({ getOnboardingState: mocks.state }));
vi.mock('@/lib/cloud/plans', () => ({ getOrganizationEntitlement: async () => ({ plan: { id: 'free', maxActiveAccounts: 1 } }) }));
vi.mock('@/lib/cloud/provider-oauth', () => ({ oauthAvailability: () => ({}), REDDIT_CONVERSIONS_SCOPE: 'adsconversions' }));
vi.mock('@/lib/cloud/repository', () => ({ listConnections: mocks.connections, listOrganizationAdAccounts: mocks.accounts }));
vi.mock('@/lib/cloud/usage', () => ({ getOrganizationUsage: async () => ({ projects: 1, enabledAccounts: 1 }) }));
vi.mock('@/lib/env', () => ({ env: () => ({ ADPORT_CLOUD_BASE_URL: 'https://app.adport.test' }) }));
vi.mock('@/lib/return-path', () => ({ safeDashboardReturnPath: () => '/dashboard' }));
vi.mock('@/lib/cloud/assistant-listings', () => ({ getAssistantListings: () => ({}) }));
vi.mock('@/lib/cloud/billing-options', () => ({ upgradeBillingOptions: () => [] }));
vi.mock('@/app/onboarding/onboarding-flow', () => ({ OnboardingFlow: () => null }));
vi.mock('@/components/project-switcher', () => ({ ProjectSwitcher: () => null }));
vi.mock('@/components/product-analytics', () => ({ ProductAnalytics: () => null }));
vi.mock('@/components/support-widget', () => ({ SupportWidget: () => null }));
vi.mock('@/components/upgrade-context', () => ({ UpgradeProvider: () => null }));

import OnboardingPage from '@/app/onboarding/page';
import { OnboardingFlow } from '@/app/onboarding/onboarding-flow';
import { ProviderConnections } from '@/app/dashboard/connections/provider-connections';

function flowProps(node: ReactNode): ComponentProps<typeof OnboardingFlow> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<ComponentProps<typeof OnboardingFlow> & { children?: ReactNode }>(child)) continue;
    if (child.type === OnboardingFlow) return child.props;
    const found = flowProps(child.props.children);
    if (found) return found;
  }
}

it.each([true, false])('keeps the stored Reddit conversion permission when reconnecting from onboarding (%s)', async enabled => {
  mocks.connections.mockResolvedValue([{ provider: 'reddit', status: 'connected', scopes: enabled ? ['adsread', 'adsedit', 'adsconversions'] : ['adsread', 'adsedit'], connectedAt: new Date('2026-11-18T00:00:00Z') }]);
  const page = await OnboardingPage({ searchParams: Promise.resolve({ resume: '1' }) });
  const connections: ConnectionView[] | undefined = flowProps(page)?.connections;
  expect(connections).toEqual([expect.objectContaining({ provider: 'reddit', redditConversionsEnabled: enabled })]);
  const html = renderToStaticMarkup(createElement(ProviderConnections, { organizationId: 'project', projectName: 'Fixture', canManage: true,
    connections: connections!, oauthProviders: [{ id: 'reddit', available: true }], variant: 'onboarding' }));
  expect(html.includes('/api/oauth/reddit/start?organization_id=project&amp;conversions=1')).toBe(enabled);
});

it('resumes at the assistant only for a usable saved account, while honoring an explicit step', async () => {
  mocks.connections.mockResolvedValue([{ provider: 'google', status: 'connected', scopes: [], connectedAt: new Date() }]);
  mocks.accounts.mockResolvedValueOnce([{ provider: 'google', accountId: 'a', enabled: true }])
    .mockResolvedValueOnce([{ provider: 'google', accountId: 'a', enabled: true }])
    .mockResolvedValueOnce([{ provider: 'google', accountId: 'a', enabled: false }]);
  mocks.state.mockResolvedValueOnce({ currentStep: 'welcome' }).mockResolvedValueOnce({ currentStep: 'welcome' });
  expect(flowProps(await OnboardingPage({ searchParams: Promise.resolve({}) }))?.initialStep).toBe('agent');
  expect(flowProps(await OnboardingPage({ searchParams: Promise.resolve({ step: 'connect' }) }))?.initialStep).toBe('connect');
  expect(flowProps(await OnboardingPage({ searchParams: Promise.resolve({ accounts_saved: 'google', access_enabled: '1' }) }))?.accountsEnabled).toBe(false);
});
