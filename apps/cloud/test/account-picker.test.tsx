import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountAccessManager, type AccountAccessItem } from '@/app/dashboard/accounts/account-access-manager';
import AccountsPage from '@/app/dashboard/accounts/page';
import { OnboardingFlow } from '@/app/onboarding/onboarding-flow';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';

const mocks = vi.hoisted(() => ({ inventory: vi.fn(), connections: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/cloud/dashboard', () => ({ requireDashboardTenant: async () => ({ organizationId: 'org', role: 'owner' }) }));
vi.mock('@/lib/cloud/repository', () => ({ listOrganizationAdAccounts: mocks.inventory, listConnections: mocks.connections }));
vi.mock('@/lib/cloud/plans', () => ({ getOrganizationEntitlement: async () => ({ plan: { maxActiveAccounts: 3 } }) }));
vi.mock('@/app/dashboard/agents/agent-setup-guide', () => ({ AgentSetupGuide: () => null }));

const accounts: AccountAccessItem[] = OAUTH_PROVIDERS.map((provider, index) => ({
  provider, accountId: `${provider}-id`, name: `${provider} unique account`, currency: 'EUR', status: 'available', enabled: index < 2,
}));

beforeEach(() => {
  mocks.inventory.mockResolvedValue(accounts);
  mocks.connections.mockResolvedValue([]);
});

describe('provider-specific account picker', () => {
  it.each(OAUTH_PROVIDERS)('only renders %s accounts while preserving workspace limits', (providerFilter) => {
    const html = renderToStaticMarkup(<AccountAccessManager organizationId="org" accounts={accounts} canManage maxActiveAccounts={3} providerFilter={providerFilter} />);
    expect(html).toContain(`${providerFilter} unique account`);
    for (const other of accounts.filter((account) => account.provider !== providerFilter)) expect(html).not.toContain(other.name);
    expect(html).toContain('2 / 3 active across workspace');
  });

  it('shows all accounts during ordinary account management', async () => {
    const html = renderToStaticMarkup(await AccountsPage({ searchParams: Promise.resolve({}) }));
    for (const account of accounts) expect(html).toContain(account.name);
  });

  it.each([{ select_provider: 'tiktok' }, { connected: 'tiktok' }])('scopes dashboard OAuth returns from %j', async (params) => {
    const html = renderToStaticMarkup(await AccountsPage({ searchParams: Promise.resolve(params) }));
    expect(html).toContain('tiktok unique account');
    expect(html).not.toContain('google unique account');
    expect(html).toContain('href="/dashboard/accounts"');
  });

  it('does not replace an empty provider selection with other providers', async () => {
    mocks.inventory.mockResolvedValue(accounts.filter((account) => account.provider !== 'tiktok'));
    mocks.connections.mockResolvedValue([{ provider: 'tiktok', status: 'connected' }, { provider: 'google', status: 'connected' }]);
    const html = renderToStaticMarkup(await AccountsPage({ searchParams: Promise.resolve({ select_provider: 'tiktok' }) }));
    expect(html).toContain('No TikTok Ads accounts added');
    expect(html).not.toContain('google unique account');
    expect(html).not.toContain('Google Ads');
  });

  it('ignores invalid provider parameters', async () => {
    const html = renderToStaticMarkup(await AccountsPage({ searchParams: Promise.resolve({ select_provider: 'unknown' }) }));
    for (const account of accounts) expect(html).toContain(account.name);
  });

  it('keeps read-only access read-only', () => {
    const html = renderToStaticMarkup(<AccountAccessManager organizationId="org" accounts={accounts} canManage={false} maxActiveAccounts={3} providerFilter="google" />);
    expect(html).toContain('google unique account');
    expect(html).not.toContain('>Disable</button>');
    expect(html).not.toContain('>Enable</button>');
  });

  it.each(['google', 'tiktok', undefined])('scopes onboarding after authorizing %s', (connectedProvider) => {
    const html = renderToStaticMarkup(<OnboardingFlow organizationId="org" canManage initialStep="accounts" initialAgent={null} baseUrl="https://app.adport.test" connectedProvider={connectedProvider} providers={[]} connections={[]} accounts={accounts} maxActiveAccounts={3} />);
    for (const account of accounts) {
      if (!connectedProvider || account.provider === connectedProvider) expect(html).toContain(account.name);
      else expect(html).not.toContain(account.name);
    }
  });
});
