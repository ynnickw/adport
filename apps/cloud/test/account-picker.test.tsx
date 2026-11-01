import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountAccessManager, type AccountAccessItem } from '@/app/dashboard/accounts/account-access-manager';
import AccountsPage from '@/app/dashboard/accounts/page';
import { OnboardingFlow } from '@/app/onboarding/onboarding-flow';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';
import { DEFAULT_POLICY } from '@adport/core';

const mocks = vi.hoisted(() => ({ inventory: vi.fn(), connections: vi.fn(), tenant: vi.fn(), selection: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/cloud/dashboard', () => ({ requireDashboardTenant: mocks.tenant }));
vi.mock('@/lib/cloud/account-selection', () => ({ getAccountSelection: mocks.selection }));
vi.mock('@/lib/cloud/repository', () => ({ listOrganizationAdAccounts: mocks.inventory, listConnections: mocks.connections }));
vi.mock('@/lib/cloud/plans', () => ({ getOrganizationEntitlement: async () => ({ plan: { maxActiveAccounts: 3 } }) }));
vi.mock('@/lib/cloud/usage', () => ({ getOrganizationUsage: async () => ({ enabledAccounts: 2, editingMembers: 1, projects: 1, viewers: 0 }) }));
vi.mock('@/app/dashboard/agents/agent-setup-guide', () => ({ AgentSetupGuide: () => null }));

const accounts: AccountAccessItem[] = OAUTH_PROVIDERS.map((provider, index) => ({
  provider, accountId: `${provider}-id`, name: `${provider} unique account`, currency: 'EUR', status: 'available', enabled: index < 2,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant.mockResolvedValue({ organizationId: 'org', userId: 'user', organizationName: 'Client', role: 'owner' });
  mocks.selection.mockResolvedValue(undefined);
  mocks.inventory.mockResolvedValue(accounts);
  mocks.connections.mockResolvedValue([]);
});

describe('provider-specific account picker', () => {
  it.each(OAUTH_PROVIDERS)('only renders %s accounts while preserving workspace limits', (providerFilter) => {
    const html = renderToStaticMarkup(<AccountAccessManager organizationId="org" accounts={accounts} canManage maxActiveAccounts={3} providerFilter={providerFilter} />);
    expect(html).toContain(`${providerFilter} unique account`);
    for (const other of accounts.filter((account) => account.provider !== providerFilter)) expect(html).not.toContain(other.name);
    expect(html).toContain('Organization allowance: 3 accounts');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="' + String(accounts.find(account => account.provider === providerFilter)!.enabled) + '"');
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
    expect(html).not.toContain('role="switch"');
  });

  it.each(['google', 'tiktok', undefined])('scopes onboarding after authorizing %s', (connectedProvider) => {
    const html = renderToStaticMarkup(<OnboardingFlow policy={DEFAULT_POLICY} projectName="Test project" setupKind="first_project" organizationId="org" canManage initialStep="accounts" initialAgent={null} baseUrl="https://app.adport.test" connectedProvider={connectedProvider} providers={[]} connections={[]} accounts={accounts} maxActiveAccounts={3} organizationActiveCount={2} returnTo="/dashboard" />);
    for (const account of accounts) {
      if (!connectedProvider || account.provider === connectedProvider) expect(html).toContain(account.name);
      else expect(html).not.toContain(account.name);
    }
  });
  it('keeps pending selection inside the setup step without exposing access switches yet', () => {
    const html = renderToStaticMarkup(<OnboardingFlow policy={DEFAULT_POLICY} projectName="Client project" setupKind="new_project" organizationId="org" canManage initialStep="accounts" initialAgent={null} baseUrl="https://app.adport.test" providers={[]} connections={[]} accounts={accounts} maxActiveAccounts={3} organizationActiveCount={2} returnTo="/dashboard/agents" pendingSelection={{ id: 'selection', provider: 'google', accounts: [{ provider: 'google', id: 'candidate', name: 'New client account' }] }} />);
    expect(html).toContain('New client account');
    expect(html).toContain('Choose your Google Ads accounts.');
    expect(html).toContain('Continue to enable access');
    expect(html).not.toContain('role="switch"');
    for (const account of accounts) expect(html).not.toContain(account.name);
  });

  it('loads a valid pending selection only through the current project principal', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    mocks.selection.mockResolvedValue({ id, provider: 'google', accounts: [{ provider: 'google', id: 'candidate', name: 'Private candidate' }] });
    const html = renderToStaticMarkup(await AccountsPage({ searchParams: Promise.resolve({ selection_id: id }) }));
    expect(mocks.selection).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org', userId: 'user', role: 'owner' }), id);
    expect(html).toContain('Private candidate');
    expect(html).not.toContain('role="switch"');
  });

  it('never loads candidate accounts for a viewer using a selection link', async () => {
    mocks.tenant.mockResolvedValue({ organizationId: 'org', userId: 'viewer', organizationName: 'Client', role: 'viewer' });
    mocks.selection.mockResolvedValue({ id: 'candidate', provider: 'google', accounts: [{ provider: 'google', id: 'candidate', name: 'Private candidate' }] });
    const html = renderToStaticMarkup(await AccountsPage({ searchParams: Promise.resolve({ selection_id: '11111111-1111-4111-8111-111111111111' }) }));
    expect(mocks.selection).not.toHaveBeenCalled();
    expect(html).not.toContain('Private candidate');
    expect(html).toContain('Ask a project owner or admin');
  });

});
