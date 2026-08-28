import { describe, expect, it } from 'vitest';
import { PLANS } from '@/lib/cloud/plans';

describe('Cloud plans', () => {
  it('keeps Free useful but read-only and increases bounded collaboration by tier', () => {
    expect(PLANS.reader).toMatchObject({ name: 'Free', monthlyPriceEur: 0, annualPriceEur: 0, maxActiveAccounts: 3, maxMembers: 1, writeAccess: false });
    expect(PLANS.operator).toMatchObject({ monthlyPriceEur: 29, annualPriceEur: 290, maxActiveAccounts: 5, maxMembers: 2, writeAccess: true });
    expect(PLANS.agency).toMatchObject({ monthlyPriceEur: 199, annualPriceEur: 1990, maxActiveAccounts: 25, maxMembers: 10, writeAccess: true });
    expect(PLANS.enterprise.maxActiveAccounts).toBeNull();
  });
});
