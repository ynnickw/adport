import { describe, expect, it } from 'vitest';
import { PLANS } from '@/lib/cloud/plans';

describe('Cloud plans', () => {
  it('keeps Free useful but read-only and increases bounded collaboration by tier', () => {
    expect(PLANS.reader).toMatchObject({ name: 'Free', monthlyPriceEur: 0, annualPriceEur: 0, maxActiveAccounts: 3, maxMembers: 1, writeAccess: false });
    expect(PLANS.operator).toMatchObject({ monthlyPriceEur: 19, annualPriceEur: 190, maxActiveAccounts: 5, maxMembers: 2, writeAccess: true });
    expect(PLANS.premium).toMatchObject({ monthlyPriceEur: 79, annualPriceEur: 790, maxActiveAccounts: 15, maxMembers: 5, writeAccess: true });
    expect(PLANS.agency).toMatchObject({ monthlyPriceEur: 149, annualPriceEur: 1490, maxActiveAccounts: 40, maxMembers: 15, writeAccess: true });
    expect(PLANS.enterprise.maxActiveAccounts).toBeNull();
  });
});
