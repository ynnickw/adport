import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANS } from '@/lib/cloud/plans';
const mocks = vi.hoisted(() => ({ tenant: vi.fn(), entitlement: vi.fn(), usage: vi.fn(), details: vi.fn(), forms: vi.fn(), checkout: vi.fn(), change: vi.fn(), portal: vi.fn() }));
vi.mock('@/lib/cloud/dashboard', () => ({ requireDashboardTenant: mocks.tenant }));
vi.mock('@/lib/cloud/plans', async original => ({ ...await original<typeof import('@/lib/cloud/plans')>(), getOrganizationEntitlement: mocks.entitlement }));
vi.mock('@/lib/cloud/usage', () => ({ getOrganizationUsage: mocks.usage }));
vi.mock('@/lib/cloud/workspaces', () => ({ listOrganizationProjects: async () => [] }));
vi.mock('@/lib/cloud/billing', () => ({ billingConfigured: () => true, billingPlanConfigured: () => true }));
vi.mock('@/lib/cloud/billing-plan-changes', () => ({ currentBillingDetails: mocks.details }));
vi.mock('@/components/plan-usage', () => ({ PlanUsage: () => <div>Usage</div> }));
vi.mock('@/app/dashboard/billing/billing-form', () => ({ BillingForm: (props: { label: string }) => { mocks.forms(props); return <button>{props.label}</button>; } }));
vi.mock('@/app/dashboard/billing/actions', () => ({ startProjectSubscriptionForm: mocks.checkout, changeProjectSubscriptionForm: mocks.change, openProjectBillingPortalForm: mocks.portal }));
import BillingPage from '@/app/dashboard/billing/page';
const base = { plan: PLANS.premium, status: 'active', providerCustomerId: 'cus_owned', providerSubscriptionId: 'sub_owned', billingOrganizationId: 'company', currentPeriodEnd: null, cancelAtPeriodEnd: false };
const tenant = { organizationId: 'project', organizationGroupId: 'company', organizationGroupName: 'Wettberg', organizationRole: 'owner', userId: 'owner', onboardingCompletedAt: new Date(), projects: [{ id: 'project', organizationId: 'company' }] };
const render = async (query = {}) => renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve(query) }));
beforeEach(() => { vi.clearAllMocks(); mocks.tenant.mockResolvedValue(tenant); mocks.entitlement.mockResolvedValue(base); mocks.details.mockResolvedValue({ interval: 'monthly' }); mocks.usage.mockResolvedValue({ editingMembers: 2 }); });
describe('plan management in the dashboard', () => {
  it('offers specific paid upgrades, downgrades, and Free cancellation without new trials', async () => {
    const html = await render();
    for (const text of ['Downgrade to Pro', 'Upgrade to Business', 'Downgrade to Free', 'Current plan', 'Choose your plan', '<details class="pricing-details"']) expect(html).toContain(text);
    expect(html).not.toContain('Start 7-day free trial');
    expect(html).not.toContain('One organization. Your whole team in control.');
    for (const [label, plan] of [['Downgrade to Pro', 'operator'], ['Upgrade to Business', 'agency'], ['Downgrade to Free', 'reader']]) {
      await mocks.forms.mock.calls.find(([props]) => props.label === label)![0].action({}, new FormData());
      expect(mocks.change).toHaveBeenLastCalledWith('project', plan, 'monthly', {}, expect.any(FormData));
    }
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('defaults to the actual yearly cycle and allows changing the current plan billing cycle', async () => {
    mocks.details.mockResolvedValue({ interval: 'annual' });
    expect(await render()).toContain('€390 billed yearly');
    const html = await render({ billing: 'monthly' });
    expect(html).toContain('Switch to monthly billing');
    await mocks.forms.mock.calls.find(([props]) => props.label === 'Switch to monthly billing')![0].action({}, new FormData());
    expect(mocks.change).toHaveBeenLastCalledWith('project', 'premium', 'monthly', {}, expect.any(FormData));
  });
  it('shows a pending downgrade without changing current access or offering it twice', async () => {
    mocks.details.mockResolvedValue({ interval: 'monthly', scheduled: { planId: 'operator', name: 'Pro', interval: 'monthly', startsAt: new Date('2026-12-01T00:00:00Z') } });
    const html = await render();
    expect(html).toContain('Change scheduled'); expect(html).toContain('Your Growth access stays active until then');
    expect(html).not.toContain('Downgrade to Pro');
  });
  it('labels complimentary access and starts a chosen paid plan without advertising a new trial', async () => {
    mocks.entitlement.mockResolvedValue({ ...base, billingProvider: null, providerCustomerId: null, providerSubscriptionId: null });
    const html = await render();
    expect(html).toContain('Complimentary'); expect(html).toContain('Downgrade to Pro'); expect(html).toContain('Upgrade to Business'); expect(html).not.toContain('7-day free trial');
    await mocks.forms.mock.calls.find(([props]) => props.label === 'Downgrade to Pro')![0].action({}, new FormData());
    expect(mocks.checkout).toHaveBeenCalledWith('project', 'operator', 'monthly', {}, expect.any(FormData));
    const free = mocks.forms.mock.calls.find(([props]) => props.label === 'Switch to Free')![0];
    expect(free.confirmation.description).toContain('complimentary access will end');
    expect(mocks.details).not.toHaveBeenCalled();
  });
  it('keeps billing changes owner-only', async () => {
    mocks.tenant.mockResolvedValue({ ...tenant, organizationRole: 'member' });
    const html = await render();
    expect(html).toContain('Owner approval needed'); expect(html).not.toContain('Upgrade to Business'); expect(html).not.toContain('Downgrade to Free');
    expect(mocks.forms).not.toHaveBeenCalled(); expect(mocks.details).not.toHaveBeenCalled();
  });
});
