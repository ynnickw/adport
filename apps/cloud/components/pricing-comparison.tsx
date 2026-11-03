import Link from 'next/link';
import catalog from '@/lib/cloud/plan-catalog.json';
import type { PlanId } from '@/lib/cloud/plans';
import type { UpgradePlanId } from '@/lib/cloud/plan-limit';
import { PlanCard } from './plan-card';
import { PricingEcosystem } from './pricing-integrations';
import { PricingFeatureTable } from './pricing-feature-table';

export const PAID_PLAN_IDS = ['operator', 'premium', 'agency'] as const;
export type PaidPlanId = typeof PAID_PLAN_IDS[number];

export function PricingComparison({ currentPlanId, requestedPlan, interval, billingLinks, onIntervalChange, actions, notes, canManageBilling, freeAction, context, idPrefix = 'billing', secondaryAction, showHeading = true, variant = 'full' }: {
  currentPlanId: PlanId; requestedPlan?: UpgradePlanId; interval: 'monthly' | 'annual';
  billingLinks?: { monthly: string; annual: string }; onIntervalChange?: (interval: 'monthly' | 'annual') => void;
  actions: Partial<Record<PaidPlanId, React.ReactNode>>; notes?: Partial<Record<PaidPlanId, React.ReactNode>>;
  canManageBilling: boolean; freeAction?: React.ReactNode; context?: React.ReactNode;
  idPrefix?: string; secondaryAction?: React.ReactNode; showHeading?: boolean;
  variant?: 'full' | 'dashboard';
}) {
  const compact = variant === 'dashboard';
  const free = freeAction ?? (currentPlanId === 'reader' ? <span className="pricing-action pricing-action-current">Current plan</span> : <Link className="pricing-action" href="/dashboard/accounts">View your accounts</Link>);
  const comparison = <PricingFeatureTable idPrefix={idPrefix} interval={interval} actions={{ ...actions, reader: free }} />;
  return <section className="cloud-pricing pricing-surface" aria-label="Available plans" aria-labelledby={showHeading ? `${idPrefix}-pricing-title` : undefined}>
    {showHeading ? <div className="pricing-heading">{!compact ? <p className="pricing-eyebrow">Adport Cloud pricing</p> : null}<h2 id={`${idPrefix}-pricing-title`}>{compact ? 'Choose your plan' : 'One organization. Your whole team in control.'}</h2><p>{compact ? 'Prices are per organization, shared across all your projects.' : 'Unlimited projects, free read-only viewers, and fixed pricing with no percentage of ad spend.'}</p></div> : null}
    {context}
    <div className="pricing-billing" aria-label="Billing interval">{billingLinks ? <><Link href={billingLinks.monthly} aria-current={interval === 'monthly' ? 'true' : undefined}>Monthly</Link><Link href={billingLinks.annual} aria-current={interval === 'annual' ? 'true' : undefined}>Yearly <span>Save 2 months</span></Link></> : <><button type="button" aria-pressed={interval === 'monthly'} onClick={() => onIntervalChange?.('monthly')}>Monthly</button><button type="button" aria-pressed={interval === 'annual'} onClick={() => onIntervalChange?.('annual')}>Yearly <span>Save 2 months</span></button></>}</div>
    <div className="pricing-cards">{PAID_PLAN_IDS.map(id => <PlanCard key={id} planId={id} interval={interval} compact={compact} featured={requestedPlan ? requestedPlan === id : compact ? currentPlanId === id : id === 'premium'} badge={requestedPlan === id || (!compact && !requestedPlan && id === 'premium') ? 'Recommended' : undefined} action={actions[id]} note={notes?.[id]} />)}</div>
    {compact ? <p className="pricing-shared-note pricing-paid-features">Every paid plan includes ad changes with previews and approval, budget caps, unlimited projects, and free read-only viewers.</p> : null}
    <div className="pricing-free"><div><span className="pricing-free-label">Free</span>{!compact ? <h3>Start with a read-only view.</h3> : null}<p>{catalog.reader.maxActiveAccounts} active ad accounts · {catalog.reader.maxMembers} member · {catalog.reader.maxRetentionDays}-day audit history.{!compact ? ' Unlimited projects and free read-only viewers.' : ' Read-only access.'}</p></div><div><div className="pricing-amount"><strong>€0</strong><span>forever</span></div>{free}{!compact ? <span className="pricing-trial-note">No card required</span> : null}</div></div>
    {!compact ? <><PricingEcosystem /><div className="pricing-next"><a className="pricing-compare-link" href={`#${idPrefix}-compare-plans`}>Compare all features <span aria-hidden="true">↓</span></a>{secondaryAction}</div><p className="pricing-shared-note">Prices are per organization. Active accounts and editing members are shared across its projects. Viewers can see results, but cannot change ads.</p>{comparison}</> : <details className="pricing-details"><summary>Compare all features</summary>{comparison}</details>}
    <div className="pricing-enterprise" data-requested={requestedPlan === 'enterprise'}><div><p className="pricing-eyebrow">Enterprise</p><h3>A little more room for your team.</h3><p>More than {catalog.agency.maxActiveAccounts} active accounts or {catalog.agency.maxMembers} editing members? Let’s put together a plan for your organization.</p></div>{canManageBilling ? <a className="pricing-action" href="mailto:yannick@adport.dev?subject=Adport%20custom%20plan">Talk to us</a> : <p>Ask your organization owner about a custom plan.</p>}</div>
    {!compact ? <p className="pricing-local">Prefer to host it yourself? The open-source CLI and local MCP server remain free. <a href="https://github.com/ynnickw/adport" target="_blank" rel="noreferrer">Explore the source</a>.</p> : null}
  </section>;
}
