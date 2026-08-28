import { afterEach, describe, expect, it } from 'vitest';
import { billingConfigured, billingPlanConfigured, stripePriceId } from '@/lib/cloud/billing';
import { resetEnvForTests } from '@/lib/env';

const STRIPE_ENV_KEYS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_OPERATOR_PRICE_ID',
  'STRIPE_OPERATOR_ANNUAL_PRICE_ID',
  'STRIPE_AGENCY_PRICE_ID',
  'STRIPE_AGENCY_ANNUAL_PRICE_ID',
] as const;

afterEach(() => {
  for (const key of STRIPE_ENV_KEYS) delete process.env[key];
  resetEnvForTests();
});

describe('Stripe billing configuration', () => {
  it('enables each paid plan independently after the shared Stripe configuration is present', () => {
    expect(billingConfigured()).toBe(false);

    process.env.STRIPE_SECRET_KEY = 'rk_live_test';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.STRIPE_OPERATOR_PRICE_ID = 'price_operator';
    process.env.STRIPE_OPERATOR_ANNUAL_PRICE_ID = 'price_operator_annual';
    process.env.STRIPE_AGENCY_PRICE_ID = 'price_agency';
    process.env.STRIPE_AGENCY_ANNUAL_PRICE_ID = 'price_agency_annual';
    resetEnvForTests();

    expect(billingConfigured()).toBe(true);
    expect(billingPlanConfigured('operator', 'monthly')).toBe(true);
    expect(billingPlanConfigured('operator', 'annual')).toBe(true);
    expect(billingPlanConfigured('agency', 'monthly')).toBe(true);
    expect(billingPlanConfigured('agency', 'annual')).toBe(true);
    expect(stripePriceId('operator', 'monthly')).toBe('price_operator');
    expect(stripePriceId('operator', 'annual')).toBe('price_operator_annual');
    expect(stripePriceId('agency', 'monthly')).toBe('price_agency');
    expect(stripePriceId('agency', 'annual')).toBe('price_agency_annual');
  });
});
