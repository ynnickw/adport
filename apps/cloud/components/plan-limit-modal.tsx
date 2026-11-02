'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { Button } from './controls';
import { Dialog } from './dialog';
import { billingUpgradePath, type PlanLimitDetails } from '@/lib/cloud/plan-limit';
import catalog from '@/lib/cloud/plan-catalog.json';
import { PricingComparison, PAID_PLAN_IDS, type PaidPlanId } from './pricing-comparison';
import { useUpgradeContext } from './upgrade-context';
import { BillingForm } from '@/app/dashboard/billing/billing-form';
import { startProjectSubscriptionForm, openProjectBillingPortalForm } from '@/app/dashboard/billing/actions';

export function PlanLimitModal({ limit, onClose }: { limit?: PlanLimitDetails; onClose: () => void }) {
  return limit ? <UpgradePaywall key={`${limit.kind}:${limit.recommendedPlan}:${limit.message}`} limit={limit} onClose={onClose} /> : null;
}

function UpgradePaywall({ limit, onClose }: { limit: PlanLimitDetails; onClose: () => void }) {
  const context = useUpgradeContext();
  const id = useId();
  const [interval, setInterval] = useState<'monthly' | 'annual'>('monthly');
  const [copyStatus, setCopyStatus] = useState<{ plan?: PaidPlanId; status: 'idle' | 'copied' | 'failed' }>({ status: 'idle' });
  const canManage = context.canManageBilling;
  const path = (plan = limit.recommendedPlan) => billingUpgradePath({ ...limit, recommendedPlan: plan, projectId: context.projectId ?? limit.projectId }) + '&billing=' + interval;
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);
  async function copy(plan: PaidPlanId) {
    try { await navigator.clipboard.writeText(new URL(path(plan), window.location.origin).href); setCopyStatus({ plan, status: 'copied' }); }
    catch { setCopyStatus({ plan, status: 'failed' }); }
  }
  const actions: Partial<Record<PaidPlanId, React.ReactNode>> = {};
  const notes: Partial<Record<PaidPlanId, React.ReactNode>> = {};
  for (const plan of PAID_PLAN_IDS) {
    const className = 'pricing-action' + (plan === limit.recommendedPlan ? ' pricing-action-primary' : '');
    const billing = context.billingOptions;
    if (context.planId === plan) actions[plan] = <span className="pricing-action pricing-action-current">Current plan</span>;
    else if (!canManage) actions[plan] = <Button className={className} type="button" onClick={() => void copy(plan)}>{copyStatus.plan === plan && copyStatus.status === 'copied' ? 'Link copied ✓' : `Ask owner for ${catalog[plan].name}`}</Button>;
    else if (billing?.hasSubscription) actions[plan] = billing.portalAvailable ? <BillingForm action={openProjectBillingPortalForm.bind(null, context.projectId ?? limit.projectId)} label="Manage billing" pendingLabel="Opening billing…" className={className} /> : <span className="pricing-action pricing-action-current">Billing unavailable</span>;
    else if (billing?.available[plan][interval]) actions[plan] = <BillingForm action={startProjectSubscriptionForm.bind(null, context.projectId ?? limit.projectId, plan, interval)} label={billing.trialEligible ? 'Start 7-day free trial' : `Subscribe to ${catalog[plan].name}`} pendingLabel="Opening checkout…" className={className} />;
    else actions[plan] = <span className="pricing-action pricing-action-current">Checkout unavailable</span>;
    notes[plan] = !canManage ? 'Copy a plan link for your organization owner' : billing?.hasSubscription ? 'Review changes in the billing portal' : billing?.trialEligible ? '7-day free trial · cancel anytime' : 'Cancel anytime';
  }
  return <Dialog title="Choose a plan" onClose={onClose} className="pricing-paywall pricing-surface" portal>
    <PricingComparison showHeading={false} currentPlanId={context.planId} requestedPlan={limit.recommendedPlan} interval={interval} onIntervalChange={value => { setInterval(value); setCopyStatus({ status: 'idle' }); }} actions={actions} notes={notes} canManageBilling={canManage} idPrefix={`paywall-${id}`} freeAction={<Button className="pricing-action" type="button" onClick={onClose}>{context.planId === 'reader' ? 'Continue with Free' : `Keep ${catalog[context.planId].name}`}</Button>} secondaryAction={<Button className="pricing-dismiss" type="button" onClick={onClose}>Not now</Button>}
      context={<><p className="paywall-context" role="status">{limit.message}</p>{copyStatus.status === 'failed' ? <p className="field-error" role="alert">Copying is unavailable. <Link href={path(copyStatus.plan)}>Open plan details and share that page’s address.</Link></p> : null}</>} />
  </Dialog>;
}
