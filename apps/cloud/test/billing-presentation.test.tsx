import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANS } from '@/lib/cloud/plans';

const mocks = vi.hoisted(() => ({ tenant: vi.fn(), entitlement: vi.fn() }));
vi.mock('@/lib/cloud/dashboard', () => ({ requireDashboardTenant: mocks.tenant }));
vi.mock('@/lib/cloud/plans', async original => ({ ...await original<typeof import('@/lib/cloud/plans')>(), getOrganizationEntitlement: mocks.entitlement }));
vi.mock('@/lib/cloud/usage', () => ({ getOrganizationUsage: async () => ({ activeAccounts: 3, editingMembers: 1 }) }));
vi.mock('@/lib/cloud/workspaces', () => ({ listOrganizationProjects: async () => [] }));
vi.mock('@/lib/cloud/billing', () => ({ billingConfigured: () => true, billingPlanConfigured: () => true }));
vi.mock('@/app/dashboard/billing/actions', () => ({ startProjectSubscriptionForm: () => undefined, openProjectBillingPortalForm: () => undefined, changeProjectSubscriptionForm: () => undefined }));
vi.mock('@/app/dashboard/projects/actions', () => ({ selectProjectAction: () => undefined }));
vi.mock('@/app/dashboard/billing/billing-form', () => ({ BillingForm: ({ label }: { label: string }) => <button>{label}</button> }));
vi.mock('@/components/plan-usage', () => ({ PlanUsage: () => <div>Plan usage</div> }));
import BillingPage from '@/app/dashboard/billing/page';

const tenant = { organizationId: 'project-a', organizationGroupId: 'company-a', organizationGroupName: 'Acme', organizationRole: 'owner', userId: 'owner', onboardingCompletedAt: new Date(), projects: [
  { id: 'project-a', organizationId: 'company-a', organizationName: 'Acme' },
  { id: 'project-b', organizationId: 'company-b', organizationName: 'Northstar' },
] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant.mockResolvedValue(tenant);
  mocks.entitlement.mockResolvedValue({ plan: PLANS.reader, status: 'active', providerSubscriptionId: null, providerCustomerId: null, cancelAtPeriodEnd: false, currentPeriodEnd: null });
});
const render = async (query: { plan?: string; intent?: string; billing?: string; projectId?: string } = {}) => renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve(query) }));

describe('dashboard pricing presentation', () => {
  it('shows dashboard cards with unchanged prices and contextual upgrade before usage', async () => {
    const html = await render({ intent: 'write_access', plan: 'operator' });
    expect(html).toContain('pricing-card-featured');
    for (const price of ['€19', '€39', '€79', '€0']) expect(html).toContain(price);
    expect(html).toContain('Continue with Pro');
    expect(html.indexOf('Available plans')).toBeLessThan(html.indexOf('Plan usage'));
    expect(html).toContain('Current plan');
  });
  it('shows annual totals without changing the catalog or losing the upgrade context', async () => {
    const html = await render({ billing: 'annual', intent: 'active_accounts', plan: 'premium' });
    for (const total of [190, 390, 790]) expect(html).toContain(`€${total} billed yearly`);
    expect(html).toContain('Continue with Growth');
    expect(html).toContain('intent=active_accounts');
    expect(html).toContain('projectId=project-a');
  });
  it('gives teammates plan details while reserving checkout for the organization owner', async () => {
    mocks.tenant.mockResolvedValue({ ...tenant, organizationRole: 'admin' });
    const html = await render();
    expect(html).toContain('Only your organization owner can change plans');
    expect(html).toContain('Owner approval needed');
    expect(html).not.toContain('Start 7-day free trial');
    expect(html).not.toContain('Manage billing');
  });
  it('requires an explicit switch before showing a different organization’s billing', async () => {
    const html = await render({ projectId: 'project-b', intent: 'members', plan: 'premium' });
    expect(html).toContain('View Northstar plans');
    expect(html).toContain('name="projectId" value="project-b"');
    expect(mocks.entitlement).not.toHaveBeenCalled();
    expect(html).not.toContain('Available plans');
  });
  it('never exposes billing or a switch for an inaccessible project', async () => {
    const html = await render({ projectId: 'inaccessible' });
    expect(html).toContain('You do not have access');
    expect(mocks.entitlement).not.toHaveBeenCalled();
    expect(html).not.toContain('name="projectId"');
  });
  it('preserves subscription-management and existing-price messaging for paid organizations', async () => {
    mocks.entitlement.mockResolvedValue({ plan: PLANS.premium, status: 'active', providerSubscriptionId: 'sub_test', providerCustomerId: 'cus_test', cancelAtPeriodEnd: false, currentPeriodEnd: null });
    const html = await render();
    expect(html).toContain('Manage billing');
    expect(html).toContain('keeps its current price');
    expect(html).not.toContain('Start 7-day free trial');
  });
});
