import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAccountPicker } from '@/app/account-selection/provider-account-picker';
import SelectAccountsPage from '@/app/account-selection/page';
import { POST } from '@/app/api/account-selection/route';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), inventory: vi.fn(), session: vi.fn(), tenant: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/cloud/account-selection', () => ({ getAccountSelection: mocks.get, saveAccountSelection: mocks.save }));
vi.mock('@/lib/cloud/repository', () => ({ listOrganizationAdAccounts: mocks.inventory }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session }));
vi.mock('@/lib/cloud/dashboard', () => ({ requireDashboardTenant: mocks.tenant, canAdminister: (tenant: { role: string }) => ['owner', 'admin'].includes(tenant.role) }));

const organizationId = '00000000-0000-4000-8000-000000000001';
const selectionId = '00000000-0000-4000-8000-000000000002';
const tenant = { organizationId, userId: 'user', organizationName: 'Fixture', role: 'owner', onboardingCompletedAt: null };
const request = (body: unknown) => new Request('https://app.adport.test/api/account-selection', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.tenant.mockResolvedValue(tenant); mocks.session.mockResolvedValue({ ...tenant, scopes: [] }); mocks.inventory.mockResolvedValue([]);
  mocks.get.mockResolvedValue({ id: selectionId, provider: 'google', accounts: [{ provider: 'google', id: 'a', name: 'Candidate account' }] });
  mocks.save.mockResolvedValue({ count: 1, returnPath: '/dashboard/accounts?accounts_saved=google' });
});

describe('one-time account picker', () => {
  it.each(OAUTH_PROVIDERS)('starts unchecked and supports selecting accounts for %s', provider => {
    const html = renderToStaticMarkup(<ProviderAccountPicker organizationId={organizationId} selectionId={selectionId} provider={provider}
      accounts={[{ provider, id: 'a', name: 'Candidate account' }, { provider, id: 'b', name: 'Other account' }]} initialSelectedIds={[]} />);
    expect(html).toContain('Candidate account'); expect(html).toContain('0 of 2 selected');
    expect(html).toContain('Select all'); expect(html).not.toContain('checked=""');
  });

  it('preselects only previously added accounts that are still available', () => {
    const html = renderToStaticMarkup(<ProviderAccountPicker organizationId={organizationId} selectionId={selectionId} provider="google"
      accounts={[{ provider: 'google', id: 'a', name: 'Existing account' }, { provider: 'google', id: 'b', name: 'Other account' }]} initialSelectedIds={['a', 'no-longer-accessible']} />);
    expect(html).toContain('1 of 2 selected'); expect(html).toContain('checked=""');
  });

  it.each(OAUTH_PROVIDERS)('offers explicit confirmation without checkboxes for one %s account', provider => {
    const html = renderToStaticMarkup(<ProviderAccountPicker organizationId={organizationId} selectionId={selectionId} provider={provider}
      accounts={[{ provider, id: 'a', name: 'Only account', currency: 'EUR' }]} initialSelectedIds={[]} />);
    expect(html).toContain('Only account'); expect(html).toContain('EUR'); expect(html).toContain('Add account');
    expect(html).not.toContain('type="checkbox"'); expect(html).not.toContain('Select all'); expect(html).not.toContain('Search accounts');
    expect(html).toContain('stay inactive'); expect(mocks.save).not.toHaveBeenCalled();
  });

  it('allows new users to select accounts before onboarding is completed', async () => {
    const html = renderToStaticMarkup(await SelectAccountsPage({ searchParams: Promise.resolve({ selection_id: selectionId }) }));
    expect(html).toContain('Candidate account'); expect(html).toContain('Add Google Ads accounts');
  });

  it('does not load a discovery snapshot for read-only members or invalid IDs', async () => {
    mocks.tenant.mockResolvedValue({ ...tenant, role: 'viewer' });
    expect(renderToStaticMarkup(await SelectAccountsPage({ searchParams: Promise.resolve({ selection_id: selectionId }) }))).toContain('Account selection unavailable');
    mocks.tenant.mockResolvedValue(tenant);
    await SelectAccountsPage({ searchParams: Promise.resolve({ selection_id: 'invalid' }) });
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.inventory).not.toHaveBeenCalled();
  });

  it('shows an unavailable state for an expired or consumed picker', async () => {
    mocks.get.mockResolvedValue(undefined);
    const html = renderToStaticMarkup(await SelectAccountsPage({ searchParams: Promise.resolve({ selection_id: selectionId }) }));
    expect(html).toContain('Account selection unavailable'); expect(html).not.toContain('Candidate account');
  });
});

describe('account selection API', () => {
  it('authenticates the exact organization and returns a non-cacheable result', async () => {
    const response = await POST(request({ organizationId, selectionId, accountIds: ['a'] }));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.session).toHaveBeenCalledWith(organizationId);
    expect(mocks.save).toHaveBeenCalledWith({ ...tenant, scopes: [] }, selectionId, ['a']);
  });

  it('rejects client-supplied account metadata rather than persisting it', async () => {
    const response = await POST(request({ organizationId, selectionId, accountIds: ['a'], accounts: [{ id: 'injected' }] }));
    expect(response.status).toBe(403); expect(mocks.save).not.toHaveBeenCalled();
  });

  it('does not save when session authorization fails', async () => {
    mocks.session.mockRejectedValue(new Error('No organization access'));
    expect((await POST(request({ organizationId, selectionId, accountIds: ['a'] }))).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('surfaces expiry without allowing the picker to recreate discovery', async () => {
    mocks.save.mockRejectedValue(new Error('Selection expired. Re-authorize.'));
    const response = await POST(request({ organizationId, selectionId, accountIds: ['a'] }));
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'Selection expired. Re-authorize.' });
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
