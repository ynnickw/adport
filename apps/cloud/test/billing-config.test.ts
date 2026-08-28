import { afterEach, describe, expect, it } from 'vitest';
import { billingConfigured, billingPlanConfigured } from '@/lib/cloud/billing';
import { resetEnvForTests } from '@/lib/env';

const STRIPE_ENV_KEYS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_OPERATOR_PRICE_ID',
  'STRIPE_AGENCY_PRICE_ID',
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
    resetEnvForTests();

    expect(billingConfigured()).toBe(true);
    expect(billingPlanConfigured('operator')).toBe(true);
    expect(billingPlanConfigured('agency')).toBe(false);
  });
});
