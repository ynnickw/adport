import Link from 'next/link';
import catalog from '@/lib/cloud/plan-catalog.json';
import type { PlanId } from '@/lib/cloud/plans';
import type { UpgradePlanId } from '@/lib/cloud/plan-limit';
import { PlanCard } from './plan-card';

export const PAID_PLAN_IDS = ['operator', 'premium', 'agency'] as const;
export type PaidPlanId = typeof PAID_PLAN_IDS[number];

export function PricingComparison({ currentPlanId, requestedPlan, interval, billingLinks, actions, notes, canManageBilling }: {
  currentPlanId: PlanId; requestedPlan?: UpgradePlanId; interval: 'monthly' | 'annual';
  billingLinks: { monthly: string; annual: string };
  actions: Partial<Record<PaidPlanId, React.ReactNode>>; notes?: Partial<Record<PaidPlanId, React.ReactNode>>;
  canManageBilling: boolean;
}) {
  return <section className="dashboard-pricing pricing-surface" aria-label="Available plans" id="plans">
    <div className="pricing-billing" aria-label="Billing interval"><Link href={billingLinks.monthly} aria-current={interval === 'monthly' ? 'true' : undefined}>Monthly</Link><Link href={billingLinks.annual} aria-current={interval === 'annual' ? 'true' : undefined}>Yearly <span>Save 2 months</span></Link></div>
    <div className="pricing-cards">{PAID_PLAN_IDS.map(id => <PlanCard key={id} planId={id} interval={interval} featured={requestedPlan ? requestedPlan === id : id === 'premium'} badge={currentPlanId === id ? 'Current plan' : requestedPlan === id ? 'Recommended for you' : !requestedPlan && id === 'premium' ? 'Recommended' : undefined} action={actions[id]} note={notes?.[id]} />)}</div>
    <div className="pricing-free"><div><span className="pricing-free-label">Free</span><h3>Start with a read-only view.</h3><p>{catalog.reader.maxActiveAccounts} active ad accounts · {catalog.reader.maxMembers} team seat · {catalog.reader.maxRetentionDays}-day audit history. Unlimited projects and free read-only viewers.</p></div><div><div className="pricing-amount"><strong>€0</strong><span>forever</span></div>{currentPlanId === 'reader' ? <span className="pricing-action pricing-action-current">Current plan</span> : <Link className="pricing-action" href="/dashboard/accounts">View your accounts</Link>}<span className="pricing-trial-note">No card required</span></div></div>
    <p className="pricing-shared-note">Prices are per organization. Active accounts and editing members are shared across its projects. Your AI assistant subscription or model usage is separate.</p>
    <div className="pricing-enterprise" data-requested={requestedPlan === 'enterprise'}><div><p className="pricing-eyebrow">Enterprise</p><h3>A little more room for your team.</h3><p>More than {catalog.agency.maxActiveAccounts} active accounts or {catalog.agency.maxMembers} editing members? Let’s put together a plan for your organization.</p></div>{canManageBilling ? <a className="pricing-action" href="mailto:yannick@adport.dev?subject=Adport%20custom%20plan">Talk to us</a> : <p className="inline-note">Ask your organization owner about a custom plan.</p>}</div>
  </section>;
}
