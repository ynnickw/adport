import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANS, type OrganizationEntitlement } from '@/lib/cloud/plans';
import { planChangeLabel, trialEligible } from '@/lib/plan-change';
const mocks = vi.hoisted(() => ({ retrieve: vi.fn(), portal: vi.fn(), price: vi.fn(), schedule: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: () => ({ ADPORT_CLOUD_BASE_URL: 'https://app.adport.dev', STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_fixture' }) }));
vi.mock('@/lib/cloud/billing', () => ({
  stripeClient: () => ({ subscriptions: { retrieve: mocks.retrieve }, billingPortal: { sessions: { create: mocks.portal } }, prices: { retrieve: mocks.price }, subscriptionSchedules: { retrieve: mocks.schedule } }),
  stripePriceId: (plan: string, interval: string) => `price_${plan}_${interval}`,
  planForPrice: (id: string) => id === 'price_operator_monthly' ? 'operator' : undefined,
  lockBillingOrganization: vi.fn(), applyOrganizationPlanLimits: vi.fn(),
}));
import { currentBillingDetails, subscriptionPlanChangeUrl } from '@/lib/cloud/billing-plan-changes';
const entitlement: OrganizationEntitlement = { plan: PLANS.premium, status: 'active', providerCustomerId: 'cus_owned', providerSubscriptionId: 'sub_owned', currentPeriodEnd: null, cancelAtPeriodEnd: false };
const subscription = () => ({ id: 'sub_owned', customer: 'cus_owned', status: 'active', metadata: { organizationId: 'company' }, schedule: null, items: { has_more: false, data: [{ id: 'si_owned', price: { id: 'price_premium_monthly', recurring: { interval: 'month' } }, quantity: 1 }] } });
beforeEach(() => { vi.resetAllMocks(); mocks.retrieve.mockResolvedValue(subscription()); mocks.portal.mockResolvedValue({ url: 'https://billing.stripe.com/confirm' }); });
describe('confirmed subscription changes', () => {
  it.each([['agency', 'monthly'], ['operator', 'annual']] as const)('preselects %s %s on the existing subscription', async (plan, interval) => {
    expect(await subscriptionPlanChangeUrl(entitlement, 'company', plan, interval)).toBe('https://billing.stripe.com/confirm');
    expect(mocks.retrieve).toHaveBeenCalledWith('sub_owned');
    expect(mocks.portal).toHaveBeenCalledWith({ customer: 'cus_owned', configuration: 'bpc_fixture', return_url: 'https://app.adport.dev/dashboard/billing', flow_data: { type: 'subscription_update_confirm', subscription_update_confirm: { subscription: 'sub_owned', items: [{ id: 'si_owned', price: `price_${plan}_${interval}`, quantity: 1 }] } } });
  });
  it('opens Free cancellation confirmation instead of canceling directly', async () => {
    await subscriptionPlanChangeUrl(entitlement, 'company', 'reader', 'monthly');
    expect(mocks.portal.mock.calls[0]![0].flow_data).toEqual({ type: 'subscription_cancel', subscription_cancel: { subscription: 'sub_owned' } });
  });
  it.each([{ customer: 'cus_other' }, { metadata: { organizationId: 'another-company' } }, { status: 'canceled' }])('rejects mismatched or ended subscription %j', async override => {
    mocks.retrieve.mockResolvedValue({ ...subscription(), ...override });
    await expect(subscriptionPlanChangeUrl(entitlement, 'company', 'agency', 'monthly')).rejects.toThrow();
    expect(mocks.portal).not.toHaveBeenCalled();
  });
  it('rejects missing billing, multi-item subscriptions, and no-op changes', async () => {
    await expect(subscriptionPlanChangeUrl({ ...entitlement, providerSubscriptionId: null }, 'company', 'agency', 'monthly')).rejects.toThrow('required');
    expect(mocks.retrieve).not.toHaveBeenCalled();
    mocks.retrieve.mockResolvedValueOnce({ ...subscription(), items: { has_more: false, data: [...subscription().items.data, { id: 'si_second' }] } });
    await expect(subscriptionPlanChangeUrl(entitlement, 'company', 'agency', 'monthly')).rejects.toThrow('manual billing review');
    await expect(subscriptionPlanChangeUrl(entitlement, 'company', 'premium', 'monthly')).rejects.toThrow('already active');
    expect(mocks.portal).not.toHaveBeenCalled();
  });
  it('reports the current billing interval and a future scheduled downgrade', async () => {
    const starts = Math.floor(Date.now() / 1000) + 86400;
    mocks.retrieve.mockResolvedValue({ ...subscription(), schedule: 'sched_owned' });
    mocks.schedule.mockResolvedValue({ status: 'active', phases: [{ start_date: starts - 172800, items: [{ price: 'price_premium_monthly' }] }, { start_date: starts, items: [{ price: 'price_operator_monthly' }] }] });
    mocks.price.mockResolvedValue({ recurring: { interval: 'month' } });
    expect(await currentBillingDetails(entitlement, 'company')).toEqual({ interval: 'monthly', scheduled: { planId: 'operator', name: 'Pro', interval: 'monthly', startsAt: new Date(starts * 1000) } });
  });
  it('does not show completed schedules as future changes', async () => {
    mocks.retrieve.mockResolvedValue({ ...subscription(), schedule: 'sched_owned' });
    mocks.schedule.mockResolvedValue({ status: 'completed', phases: [] });
    expect(await currentBillingDetails(entitlement, 'company')).toEqual({ interval: 'monthly' });
  });
});
it('labels upgrades, downgrades and interval changes, reserving trials for new Free accounts', () => {
  expect(planChangeLabel('premium', 'operator', 'monthly')).toBe('Downgrade to Pro');
  expect(planChangeLabel('premium', 'agency', 'annual')).toBe('Upgrade to Business');
  expect(planChangeLabel('premium', 'premium', 'annual')).toBe('Switch to yearly billing');
  expect(trialEligible('reader', null)).toBe(true); expect(trialEligible('premium', null)).toBe(false); expect(trialEligible('reader', 'sub_old')).toBe(false);
});
