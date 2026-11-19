import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { ConnectionView } from '@/app/dashboard/connections/provider-connections';

const mocks = vi.hoisted(() => ({ connections: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/cloud/account-selection', () => ({ getAccountSelection: vi.fn() }));
vi.mock('@/lib/cloud/dashboard', () => ({ canAdminister: () => true, requireDashboardTenant: async () => ({ organizationId: 'project', userId: 'owner', organizationRole: 'owner', projects: [] }) }));
vi.mock('@/lib/cloud/onboarding', () => ({ getOnboardingState: async () => ({ currentStep: 'connect' }) }));
vi.mock('@/lib/cloud/plans', () => ({ getOrganizationEntitlement: async () => ({ plan: { id: 'free', maxActiveAccounts: 1 } }) }));
vi.mock('@/lib/cloud/provider-oauth', () => ({ oauthAvailability: () => ({}), REDDIT_CONVERSIONS_SCOPE: 'adsconversions' }));
vi.mock('@/lib/cloud/repository', () => ({ listConnections: mocks.connections, listOrganizationAdAccounts: async () => [] }));
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

function connectionViews(node: ReactNode): ConnectionView[] | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; connections?: ConnectionView[] }>(child)) continue;
    if (child.type === OnboardingFlow) return child.props.connections;
    const found = connectionViews(child.props.children);
    if (found) return found;
  }
}

it.each([true, false])('keeps the stored Reddit conversion permission when reconnecting from onboarding (%s)', async enabled => {
  mocks.connections.mockResolvedValue([{ provider: 'reddit', status: 'connected', scopes: enabled ? ['adsread', 'adsedit', 'adsconversions'] : ['adsread', 'adsedit'], connectedAt: new Date('2026-11-18T00:00:00Z') }]);
  const page = await OnboardingPage({ searchParams: Promise.resolve({ resume: '1' }) });
  const connections = connectionViews(page);
  expect(connections).toEqual([expect.objectContaining({ provider: 'reddit', redditConversionsEnabled: enabled })]);
  const html = renderToStaticMarkup(createElement(ProviderConnections, { organizationId: 'project', canManage: true,
    connections: connections!, oauthProviders: [{ id: 'reddit', available: true }], variant: 'onboarding' }));
  expect(html.includes('/api/oauth/reddit/start?organization_id=project&amp;conversions=1')).toBe(enabled);
});
