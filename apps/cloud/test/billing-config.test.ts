import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { billingConfigured, billingPlanConfigured, stripePriceId, planForPrice } from '@/lib/cloud/billing';
import { resetEnvForTests } from '@/lib/env';

const STRIPE_ENV_KEYS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PRO_PRICE_ID', 'STRIPE_PRO_ANNUAL_PRICE_ID', 'STRIPE_GROWTH_PRICE_ID', 'STRIPE_GROWTH_ANNUAL_PRICE_ID',
  'STRIPE_AGENCY_V2_PRICE_ID', 'STRIPE_AGENCY_V2_ANNUAL_PRICE_ID', 'STRIPE_LEGACY_PRICE_PLAN_MAP',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_OPERATOR_PRICE_ID',
  'STRIPE_OPERATOR_ANNUAL_PRICE_ID',
  'STRIPE_PREMIUM_PRICE_ID',
  'STRIPE_PREMIUM_ANNUAL_PRICE_ID',
  'STRIPE_AGENCY_PRICE_ID',
  'STRIPE_AGENCY_ANNUAL_PRICE_ID',
] as const;

function clearStripeEnvironment() {
  for (const key of STRIPE_ENV_KEYS) delete process.env[key];
  resetEnvForTests();
}
beforeEach(clearStripeEnvironment);
afterEach(clearStripeEnvironment);

describe('Stripe billing configuration', () => {
  it('enables each paid plan independently after the shared Stripe configuration is present', () => {
    expect(billingConfigured()).toBe(false);

    process.env.STRIPE_SECRET_KEY = 'rk_live_test';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.STRIPE_PRO_PRICE_ID = 'price_operator';
    process.env.STRIPE_PRO_ANNUAL_PRICE_ID = 'price_operator_annual';
    process.env.STRIPE_GROWTH_PRICE_ID = 'price_premium';
    process.env.STRIPE_GROWTH_ANNUAL_PRICE_ID = 'price_premium_annual';
    process.env.STRIPE_AGENCY_V2_PRICE_ID = 'price_agency';
    process.env.STRIPE_AGENCY_V2_ANNUAL_PRICE_ID = 'price_agency_annual';
    resetEnvForTests();

    expect(billingConfigured()).toBe(true);
    expect(billingPlanConfigured('operator', 'monthly')).toBe(true);
    expect(billingPlanConfigured('operator', 'annual')).toBe(true);
    expect(billingPlanConfigured('premium', 'monthly')).toBe(true);
    expect(billingPlanConfigured('premium', 'annual')).toBe(true);
    expect(billingPlanConfigured('agency', 'monthly')).toBe(true);
    expect(billingPlanConfigured('agency', 'annual')).toBe(true);
    expect(stripePriceId('operator', 'monthly')).toBe('price_operator');
    expect(stripePriceId('operator', 'annual')).toBe('price_operator_annual');
    expect(stripePriceId('premium', 'monthly')).toBe('price_premium');
    expect(stripePriceId('premium', 'annual')).toBe('price_premium_annual');
    expect(stripePriceId('agency', 'monthly')).toBe('price_agency');
    expect(stripePriceId('agency', 'annual')).toBe('price_agency_annual');
  });
});

 it('accepts grandfathered prices for webhooks without offering them to new checkouts', () => {
   process.env.STRIPE_OPERATOR_PRICE_ID = 'price_operator_old';
   process.env.STRIPE_PREMIUM_PRICE_ID = 'price_premium_old';
   process.env.STRIPE_AGENCY_PRICE_ID = 'price_agency_old';
   process.env.STRIPE_GROWTH_PRICE_ID = 'price_growth_new';
   process.env.STRIPE_LEGACY_PRICE_PLAN_MAP = JSON.stringify({price_older_agency:'agency'});
   resetEnvForTests();
   expect(planForPrice('price_premium_old')).toBe('premium');
   expect(planForPrice('price_operator_old')).toBe('operator');
   expect(planForPrice('price_agency_old')).toBe('agency');
   expect(planForPrice('price_older_agency')).toBe('agency');
   expect(planForPrice('price_growth_new')).toBe('premium');
   expect(stripePriceId('premium','monthly')).toBe('price_growth_new');
   expect(() => stripePriceId('agency','monthly')).toThrow('not configured');
 });
