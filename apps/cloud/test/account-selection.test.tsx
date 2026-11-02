import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAccountPicker } from '@/app/account-selection/provider-account-picker';
import SelectAccountsPage from '@/app/account-selection/page';
import { POST } from '@/app/api/account-selection/route';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), inventory: vi.fn(), session: vi.fn(), tenant: vi.fn(), entitlement: vi.fn() }));
vi.mock('@/lib/cloud/plans', async original => ({ ...await original<typeof import('@/lib/cloud/plans')>(), getOrganizationEntitlement: mocks.entitlement }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('REDIRECT:' + path); }, useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
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
  mocks.get.mockResolvedValue({ id: selectionId, provider: 'google', returnPath: '/dashboard/accounts?select_provider=google', accounts: [{ provider: 'google', id: 'a', name: 'Candidate account' }] });
  mocks.save.mockResolvedValue({ count: 1, returnPath: '/dashboard/accounts?accounts_saved=google' });
  mocks.entitlement.mockResolvedValue({ plan: { id: 'reader', name: 'Free', maxActiveAccounts: 3 } });
});

describe('one-time account picker', () => {
  it('shows separate, unchecked Facebook Pages even for a single ad account', () => {
    const html = renderToStaticMarkup(<ProviderAccountPicker organizationId={organizationId} selectionId={selectionId} provider="meta"
      accounts={[{ provider: 'meta', id: 'a', name: 'Ad account' }]} initialSelectedIds={[]}
      pages={[{ id: '123', name: 'Managed Page', category: 'Software' }]} />);
    expect(html).toContain('Facebook Pages'); expect(html).toContain('Allow Page Managed Page (123)');
    expect(html).toContain('0 of 1 selected'); expect(html).not.toContain('checked=""');
    expect(html).toContain('Add and enable 1 account'); expect(html).toContain('About Page access');
  });

  it('explains that an empty Page selection grants no Page access', () => {
    const html = renderToStaticMarkup(<ProviderAccountPicker organizationId={organizationId} selectionId={selectionId} provider="meta"
      accounts={[]} initialSelectedIds={[]} pages={[]} />);
    expect(html).toContain('Meta returned no Pages'); expect(html).toContain('Page tools will have no access');
  });
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
    expect(html).toContain('Only account'); expect(html).toContain('EUR'); expect(html).toContain('Add and enable 1 account');
    expect(html).not.toContain('type="checkbox"'); expect(html).not.toContain('Select all'); expect(html).not.toContain('Search accounts');
    expect(html).toContain('Import without enabling'); expect(mocks.save).not.toHaveBeenCalled();
  });

  it('keeps new-user selection inside onboarding before setup is completed', async () => {
    await expect(SelectAccountsPage({ searchParams: Promise.resolve({ selection_id: selectionId }) })).rejects.toThrow('REDIRECT:/onboarding?selection_id=' + selectionId + '&resume=1&return_to=');
    expect(mocks.get).toHaveBeenCalledWith({ ...tenant, scopes: [] }, selectionId);
  });

  it('keeps an existing project in its Accounts page', async () => {
    mocks.tenant.mockResolvedValue({ ...tenant, onboardingCompletedAt: new Date() });
    await expect(SelectAccountsPage({ searchParams: Promise.resolve({ selection_id: selectionId }) })).rejects.toThrow('REDIRECT:/dashboard/accounts?selection_id=' + selectionId);
  });

  it('does not load a discovery snapshot for read-only members or invalid IDs', async () => {
    mocks.tenant.mockResolvedValue({ ...tenant, role: 'viewer' });
    await expect(SelectAccountsPage({ searchParams: Promise.resolve({ selection_id: selectionId }) })).rejects.toThrow('REDIRECT:');
    mocks.tenant.mockResolvedValue(tenant);
    await expect(SelectAccountsPage({ searchParams: Promise.resolve({ selection_id: 'invalid' }) })).rejects.toThrow('REDIRECT:');
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.inventory).not.toHaveBeenCalled();
  });

  it('returns an expired picker to the existing flow with a recovery message', async () => {
    mocks.get.mockResolvedValue(undefined);
    await expect(SelectAccountsPage({ searchParams: Promise.resolve({ selection_id: selectionId }) })).rejects.toThrow('selection_unavailable=1');
  });

});

describe('account selection API', () => {
  it('uses the server entitlement for explicit activation, never a client-provided allowance', async () => {
    expect((await POST(request({ organizationId, selectionId, accountIds: ['a'], enableAccess: true }))).status).toBe(200);
    expect(mocks.entitlement).toHaveBeenCalledWith(organizationId);
    expect(mocks.save).toHaveBeenCalledWith({ ...tenant, scopes: [] }, selectionId, ['a'], undefined, { maxActiveAccounts: 3, currentPlan: 'Free', recommendedPlan: 'operator' });
    mocks.save.mockClear();
    expect((await POST(request({ organizationId, selectionId, accountIds: ['a'], enableAccess: true, maxActiveAccounts: 10000 }))).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('passes only explicit Page ids to the tenant-scoped save', async () => {
    const response = await POST(request({ organizationId, selectionId, accountIds: ['a'], pageIds: ['123'] }));
    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({ ...tenant, scopes: [] }, selectionId, ['a'], ['123'], undefined);
  });

  it('rejects malformed Page ids', async () => {
    expect((await POST(request({ organizationId, selectionId, accountIds: [], pageIds: ['../me'] }))).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('authenticates the exact organization and returns a non-cacheable result', async () => {
    const response = await POST(request({ organizationId, selectionId, accountIds: ['a'] }));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.session).toHaveBeenCalledWith(organizationId);
    expect(mocks.save).toHaveBeenCalledWith({ ...tenant, scopes: [] }, selectionId, ['a'], undefined, undefined);
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
