'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { Button } from './controls';
import { Dialog } from './dialog';
import { billingUpgradePath, PLAN_LIMIT_TITLES, type PlanLimitDetails } from '@/lib/cloud/plan-limit';
import catalog from '@/lib/cloud/plan-catalog.json';
import { PricingComparison, PAID_PLAN_IDS, type PaidPlanId } from './pricing-comparison';
import { useUpgradeContext } from './upgrade-context';
import { BillingForm } from '@/app/dashboard/billing/billing-form';
import { startProjectSubscriptionForm, changeProjectSubscriptionForm } from '@/app/dashboard/billing/actions';
import { planChangeLabel } from '@/lib/plan-change';
import { useToast } from './toast';

export function PlanLimitModal({ limit, onClose }: { limit?: PlanLimitDetails; onClose: () => void }) {
  return limit ? <UpgradePaywall key={`${limit.kind}:${limit.recommendedPlan}:${limit.message}`} limit={limit} onClose={onClose} /> : null;
}

function UpgradePaywall({ limit, onClose }: { limit: PlanLimitDetails; onClose: () => void }) {
  const context = useUpgradeContext();
  const id = useId();
  const [interval, setInterval] = useState<'monthly' | 'annual'>('monthly');
  const [copyFailedFor, setCopyFailedFor] = useState<PaidPlanId>();
  const toast = useToast();
  const canManage = context.canManageBilling;
  const path = (plan = limit.recommendedPlan) => billingUpgradePath({ ...limit, recommendedPlan: plan, projectId: context.projectId ?? limit.projectId }) + '&billing=' + interval;
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);
  async function copy(plan: PaidPlanId) {
    try { await navigator.clipboard.writeText(new URL(path(plan), window.location.origin).href); setCopyFailedFor(undefined); toast('Plan link copied.'); }
    catch { setCopyFailedFor(plan); }
  }
  const actions: Partial<Record<PaidPlanId, React.ReactNode>> = {};
  const notes: Partial<Record<PaidPlanId, React.ReactNode>> = {};
  const minimum = limit.recommendedPlan === 'enterprise' ? PAID_PLAN_IDS.length : PAID_PLAN_IDS.indexOf(limit.recommendedPlan);
  for (const plan of PAID_PLAN_IDS) {
    const className = 'pricing-action' + (plan === limit.recommendedPlan ? ' pricing-action-primary' : '');
    const billing = context.billingOptions;
    const coversRequest = PAID_PLAN_IDS.indexOf(plan) >= minimum;
    if (context.planId === plan) actions[plan] = <span className="pricing-action pricing-action-current">Current plan</span>;
    else if (!coversRequest) actions[plan] = <span className="pricing-action pricing-action-current">Doesn’t cover this request</span>;
    else if (!canManage) actions[plan] = <Button className={className} type="button" onClick={() => void copy(plan)}>Copy {catalog[plan].name} plan link</Button>;
    else if (billing?.hasSubscription) actions[plan] = billing.portalAvailable && billing.available[plan][interval] ? <BillingForm key={interval} action={changeProjectSubscriptionForm.bind(null, context.projectId ?? limit.projectId, plan, interval)} label={planChangeLabel(context.planId, plan, interval)} pendingLabel="Opening plan change…" className={className} /> : <span className="pricing-action pricing-action-current">Billing unavailable</span>;
    else if (billing?.available[plan][interval]) actions[plan] = <BillingForm key={interval} action={startProjectSubscriptionForm.bind(null, context.projectId ?? limit.projectId, plan, interval)} label={context.planId !== 'reader' ? planChangeLabel(context.planId, plan, interval) : billing.trialEligible ? 'Start 7-day free trial' : `Subscribe to ${catalog[plan].name}`} pendingLabel="Opening checkout…" className={className} />;
    else actions[plan] = <span className="pricing-action pricing-action-current">Checkout unavailable</span>;
    notes[plan] = coversRequest && canManage && context.planId !== plan && billing?.available[plan][interval]
      ? billing.hasSubscription ? billing.portalAvailable ? 'Review changes in the billing portal' : null
        : billing.trialEligible ? 'Cancel before the trial ends to avoid a charge' : 'Cancel anytime' : null;
  }
  return <Dialog title={PLAN_LIMIT_TITLES[limit.kind]} onClose={onClose} className="pricing-paywall pricing-surface" portal>
    <div className="paywall-scroll">
      <PricingComparison variant="paywall" showHeading={false} currentPlanId={context.planId} requestedPlan={limit.recommendedPlan} interval={interval}
        onIntervalChange={value => { setInterval(value); setCopyFailedFor(undefined); }} actions={actions} notes={notes} canManageBilling={canManage} idPrefix={`paywall-${id}`}
        context={<div className="paywall-context"><p>{limit.message}</p><p className="paywall-plan-context">
          Current plan: <strong>{catalog[context.planId].name}</strong> <span aria-hidden="true">·</span> {canManage ? 'Billed per organization' : 'Only your organization owner can change plans. Share a plan link with them.'}</p>
          {copyFailedFor ? <p className="field-error" role="alert">Copying is unavailable. <Link href={path(copyFailedFor)}>Open plan details and share that page’s address.</Link></p> : null}
        </div>} />
    </div>
    <footer className="paywall-footer"><span>Nothing changes until you confirm in billing.</span>
      <Button className="button secondary" type="button" onClick={onClose}>{context.planId === 'reader' ? 'Continue with Free' : `Keep ${catalog[context.planId].name}`}</Button>
    </footer>
  </Dialog>;
}
