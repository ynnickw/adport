import { describe, expect, it } from 'vitest';
import { PLANS } from '@/lib/cloud/plans';

describe('Cloud plans', () => {
  it('keeps Reader useful but read-only and increases bounded collaboration by tier', () => {
    expect(PLANS.reader).toMatchObject({ monthlyPriceEur: 0, maxActiveAccounts: 1, maxMembers: 1, writeAccess: false });
    expect(PLANS.operator).toMatchObject({ monthlyPriceEur: 49, maxActiveAccounts: 5, maxMembers: 2, writeAccess: true });
    expect(PLANS.agency).toMatchObject({ monthlyPriceEur: 199, maxActiveAccounts: 25, maxMembers: 10, writeAccess: true });
    expect(PLANS.enterprise.maxActiveAccounts).toBeNull();
  });
});
