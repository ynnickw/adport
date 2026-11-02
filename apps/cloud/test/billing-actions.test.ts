import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  checkout: vi.fn(), portal: vi.fn(), redirect: vi.fn((url: string): never => { throw new Error(`redirect:${url}`); }),
  sessionPrincipal: vi.fn(), entitlement: vi.fn(), organization: vi.fn(),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/cloud/product-analytics', () => ({ captureProductEvent: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: () => ({ ADPORT_CLOUD_BASE_URL: 'https://app.adport.dev', STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_expected' }) }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.sessionPrincipal }));
vi.mock('@/lib/cloud/plans', () => ({ getOrganizationEntitlement: mocks.entitlement }));
vi.mock('@/lib/cloud/workspaces', () => ({ requireOrganizationAdmin: mocks.organization }));
vi.mock('@/lib/cloud/billing-checkout', () => ({ subscriptionCheckoutUrl: mocks.checkout }));
vi.mock('@/lib/cloud/billing', () => ({ stripeClient: () => ({ billingPortal: { sessions: { create: mocks.portal } } }) }));
import { startSubscription, startSubscriptionForm, openBillingPortalForm, startProjectSubscriptionForm, openProjectBillingPortalForm } from '@/app/dashboard/billing/actions';

describe('billing actions and ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionPrincipal.mockResolvedValue({ organizationId: 'client-project', userId: 'owner', role: 'owner' });
    mocks.entitlement.mockResolvedValue({ billingOrganizationId: 'shared-company', providerCustomerId: 'cus_existing' });
    mocks.organization.mockResolvedValue({ role: 'owner' });
    mocks.checkout.mockResolvedValue('https://checkout.stripe.com/session');
    mocks.portal.mockResolvedValue({ url: 'https://billing.stripe.com/session' });
  });
  it('uses the shared billing organization when checkout starts inside a project', async () => {
    await expect(startSubscription('premium', 'annual')).rejects.toThrow('redirect:');
    expect(mocks.checkout).toHaveBeenCalledWith('shared-company', 'owner', 'premium', 'annual');
  });
  it('checks organization ownership in addition to project ownership', async () => {
    mocks.organization.mockResolvedValue({ role: 'admin' });
    await expect(startSubscription('operator', 'monthly')).rejects.toThrow('Only the workspace owner');
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('rejects non-owners before starting checkout or a portal session', async () => {
    mocks.sessionPrincipal.mockResolvedValue({ role: 'member' });
    await expect(startSubscription('operator', 'monthly')).rejects.toThrow('Only the workspace owner');
    await openBillingPortalForm({}, new FormData());
    expect(mocks.checkout).not.toHaveBeenCalled(); expect(mocks.portal).not.toHaveBeenCalled();
  });
  it('validates the plan and interval before requesting checkout', async () => {
    await expect(startSubscription('reader', 'monthly')).rejects.toThrow('Choose Pro');
    await expect(startSubscription('operator', 'invalid' as never)).rejects.toThrow('Choose monthly');
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('keeps provider errors private and permits retrying the form', async () => {
    mocks.checkout.mockRejectedValueOnce(new Error('private provider detail'));
    expect(await startSubscriptionForm('premium', 'annual', {}, new FormData())).toEqual({ error: 'Checkout could not be opened. Please try again or contact support.' });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
  it('keeps successful redirects outside form error handling', async () => {
    await expect(startSubscriptionForm('premium', 'annual', {}, new FormData())).rejects.toThrow('redirect:https://checkout.stripe.com/session');
  });
  it('opens the configured portal for the billing customer', async () => {
    await expect(openBillingPortalForm({}, new FormData())).rejects.toThrow('redirect:https://billing.stripe.com/session');
    expect(mocks.portal).toHaveBeenCalledWith({ customer: 'cus_existing', configuration: 'bpc_expected', return_url: 'https://app.adport.dev/dashboard/billing' });
  });
  it('binds paywall checkout and portal access to the displayed project instead of the active cookie', async () => {
    await expect(startProjectSubscriptionForm('displayed-project', 'premium', 'annual', {}, new FormData())).rejects.toThrow('redirect:');
    expect(mocks.sessionPrincipal).toHaveBeenLastCalledWith('displayed-project');
    expect(mocks.checkout).toHaveBeenCalledWith('shared-company', 'owner', 'premium', 'annual');
    await expect(openProjectBillingPortalForm('displayed-project', {}, new FormData())).rejects.toThrow('redirect:');
    expect(mocks.sessionPrincipal).toHaveBeenLastCalledWith('displayed-project');
  });
  it('does not create a checkout when membership in the displayed project has been revoked', async () => {
    mocks.sessionPrincipal.mockRejectedValue(new Error('Project access revoked'));
    expect(await startProjectSubscriptionForm('revoked-project', 'operator', 'monthly', {}, new FormData())).toHaveProperty('error');
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.portal).not.toHaveBeenCalled();
  });

});
