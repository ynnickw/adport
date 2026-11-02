import catalog from './cloud/plan-catalog.json';
import type { BillingInterval, PlanId } from './cloud/plans';

const order: PlanId[] = ['reader', 'operator', 'premium', 'agency', 'enterprise'];

export function planChangeLabel(current: PlanId, target: PlanId, interval: BillingInterval): string {
  if (current === target) return `Switch to ${interval === 'annual' ? 'yearly' : 'monthly'} billing`;
  return `${order.indexOf(target) > order.indexOf(current) ? 'Upgrade' : 'Downgrade'} to ${catalog[target].name}`;
}

export function trialEligible(plan: PlanId, subscriptionId: string | null): boolean {
  return plan === 'reader' && !subscriptionId;
}
