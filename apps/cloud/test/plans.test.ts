import { describe, expect, it, vi } from 'vitest';
import { applyPlanToPrincipal, PLANS } from '@/lib/cloud/plans';

vi.mock('@/lib/db', () => ({
  db: () => {
    const query = () => Promise.resolve([{
      plan: 'reader', status: 'active', providerCustomerId: null, providerSubscriptionId: null,
      currentPeriodEnd: null, cancelAtPeriodEnd: false,
    }]);
    return query;
  },
}));

describe('Cloud plans', () => {
  it('keeps Free useful but read-only and increases bounded collaboration by tier', () => {
    expect(PLANS.reader).toMatchObject({ name: 'Free', monthlyPriceEur: 0, annualPriceEur: 0, maxActiveAccounts: 3, maxMembers: 1, writeAccess: false });
    expect(PLANS.operator).toMatchObject({ monthlyPriceEur: 19, annualPriceEur: 190, maxActiveAccounts: 5, maxMembers: 2, writeAccess: true });
    expect(PLANS.premium).toMatchObject({ monthlyPriceEur: 79, annualPriceEur: 790, maxActiveAccounts: 15, maxMembers: 5, writeAccess: true });
    expect(PLANS.agency).toMatchObject({ monthlyPriceEur: 149, annualPriceEur: 1490, maxActiveAccounts: 40, maxMembers: 15, writeAccess: true });
    expect(PLANS.enterprise.maxActiveAccounts).toBeNull();
  });

  it('keeps credential grants while applying the current plan to effective scopes', async () => {
    const principal = await applyPlanToPrincipal({
      organizationId: 'org-free',
      role: 'owner',
      scopes: ['tools:read', 'tools:write'],
    });

    expect(principal.scopes).toEqual(['tools:read']);
    expect(principal.grantedScopes).toEqual(['tools:read', 'tools:write']);
    expect(principal.entitlement).toEqual({ planId: 'reader', planName: 'Free', writeAccess: false });
  });
});
