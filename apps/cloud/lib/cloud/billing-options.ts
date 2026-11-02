import 'server-only';
import { billingConfigured, billingPlanConfigured } from './billing';
import { subscriptionEnded, type OrganizationEntitlement, type BillingInterval } from './plans';

export interface BillingOptions {
  hasSubscription: boolean;
  portalAvailable: boolean;
  trialEligible: boolean;
  available: Record<'operator' | 'premium' | 'agency', Record<BillingInterval, boolean>>;
}

export function upgradeBillingOptions(entitlement: OrganizationEntitlement): BillingOptions {
  const hasSubscription = Boolean(entitlement.providerSubscriptionId && !subscriptionEnded(entitlement.status));
  return {
    hasSubscription,
    portalAvailable: hasSubscription && Boolean(entitlement.providerCustomerId) && billingConfigured(),
    trialEligible: !entitlement.providerSubscriptionId,
    available: {
      operator: { monthly: billingPlanConfigured('operator', 'monthly'), annual: billingPlanConfigured('operator', 'annual') },
      premium: { monthly: billingPlanConfigured('premium', 'monthly'), annual: billingPlanConfigured('premium', 'annual') },
      agency: { monthly: billingPlanConfigured('agency', 'monthly'), annual: billingPlanConfigured('agency', 'annual') },
    },
  };
}
