import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkoutCreate: vi.fn(),
  redirect: vi.fn((url: string): never => { throw new Error(`redirect:${url}`); }),
  sessionPrincipal: vi.fn(),
  getOrganizationEntitlement: vi.fn(),
  stripePriceId: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/env', () => ({ env: () => ({ ADPORT_CLOUD_BASE_URL: 'https://app.adport.dev' }) }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.sessionPrincipal }));
vi.mock('@/lib/cloud/plans', () => ({ getOrganizationEntitlement: mocks.getOrganizationEntitlement }));
vi.mock('@/lib/cloud/billing', () => ({
  stripePriceId: mocks.stripePriceId,
  stripeClient: () => ({ checkout: { sessions: { create: mocks.checkoutCreate } } }),
}));

import { startSubscription } from '@/app/dashboard/billing/actions';

describe('subscription checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionPrincipal.mockResolvedValue({ organizationId: '00000000-0000-4000-8000-000000000001', role: 'owner' });
    mocks.getOrganizationEntitlement.mockResolvedValue({ providerCustomerId: null, providerSubscriptionId: null });
    mocks.stripePriceId.mockReturnValue('price_premium_annual');
    mocks.checkoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/session' });
  });

  it('starts Premium annual Checkout with a seven-day trial and organization metadata', async () => {
    await expect(startSubscription('premium', 'annual')).rejects.toThrow('redirect:https://checkout.stripe.com/session');
    expect(mocks.stripePriceId).toHaveBeenCalledWith('premium', 'annual');
    expect(mocks.checkoutCreate).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'subscription',
      line_items: [{ price: 'price_premium_annual', quantity: 1 }],
      billing_address_collection: 'required',
      metadata: expect.objectContaining({ plan: 'premium', interval: 'annual' }),
      subscription_data: {
        metadata: expect.objectContaining({ plan: 'premium', interval: 'annual' }),
        trial_period_days: 7,
      },
    }));
  });
});
