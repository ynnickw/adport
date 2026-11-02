import Link from 'next/link';
import { billingConfigured, billingPlanConfigured } from '@/lib/cloud/billing';
import { billingStatus } from '@/lib/billing-status';
import { BillingForm } from './billing-form';
import { CheckoutStatus } from './checkout-status';
import { PageHeader, formatDate } from '@/components/ui';
import { PlanUsage } from '@/components/plan-usage';
import { PricingComparison, PAID_PLAN_IDS, type PaidPlanId } from '@/components/pricing-comparison';
import { getOrganizationUsage } from '@/lib/cloud/usage';
import { listOrganizationProjects } from '@/lib/cloud/workspaces';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { getOrganizationEntitlement, PLANS, subscriptionEnded, recommendedUpgradePlan, type BillingInterval } from '@/lib/cloud/plans';
import type { PlanLimitKind, UpgradePlanId } from '@/lib/cloud/plan-limit';
import { changeProjectSubscriptionForm, openProjectBillingPortalForm, startProjectSubscriptionForm } from './actions';
import { selectProjectAction } from '../projects/actions';
import { Button } from '@/components/controls';
import { currentBillingDetails } from '@/lib/cloud/billing-plan-changes';
import { planChangeLabel, trialEligible as canStartTrial } from '@/lib/plan-change';

export const metadata = { title: 'Plan' };
const INTENT_COPY: Record<PlanLimitKind, string> = {
  active_accounts: 'More ad accounts. One connected team.', members: 'Make room for the people behind your ads.',
  retention: 'Keep the history behind every decision.', write_access: 'Turn your ad insights into action.',
};

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string; billing?: string; plan?: string; intent?: string; projectId?: string }> }) {
  const [tenant, query] = await Promise.all([requireDashboardTenant(), searchParams]);
  if (query.projectId && !tenant.projects.some(project => project.id === query.projectId && project.organizationId === tenant.organizationGroupId)) {
    const target = tenant.projects.find(project => project.id === query.projectId);
    const destination = '/dashboard/billing?' + new URLSearchParams({
      ...(query.plan ? { plan: query.plan } : {}), ...(query.intent ? { intent: query.intent } : {}),
      ...(query.billing === 'annual' ? { billing: 'annual' } : {}),
    });
    return <main className="page plan-page"><PageHeader title="Open the right organization" showDescription description={target ? `This upgrade is for ${target.organizationName}. Switch to that organization to review its plan.` : 'You do not have access to the organization in this upgrade link. Ask its owner to review the plan.'} />
      {target ? <form action={selectProjectAction}><input type="hidden" name="projectId" value={target.id} /><input type="hidden" name="return_to" value={destination} /><Button type="submit" className="button">View {target.organizationName} plans</Button></form> : <Link className="button secondary" href="/dashboard/billing">View your current plan</Link>}
    </main>;
  }
  const [entitlement, usage] = await Promise.all([getOrganizationEntitlement(tenant.organizationId), getOrganizationUsage(tenant.organizationId)]);
  const configured = billingConfigured();
  const canManage = tenant.organizationRole === 'owner';
  const hasSubscription = Boolean(entitlement.providerSubscriptionId && !subscriptionEnded(entitlement.status));
  const lifecycle = billingStatus(entitlement);
  const subscriptionReady = hasSubscription && ['active', 'trialing', 'past_due'].includes(entitlement.status);
  const checkoutPending = query.checkout === 'complete' && !subscriptionReady;
  const trialEligible = canStartTrial(entitlement.plan.id, entitlement.providerSubscriptionId);
  const complimentary = entitlement.plan.id !== 'reader' && !entitlement.providerSubscriptionId;
  const details = canManage && configured && hasSubscription
    ? await currentBillingDetails(entitlement, entitlement.billingOrganizationId ?? tenant.organizationId).catch(() => null) : null;
  const subscriptionInterval = details?.interval;
  const interval: BillingInterval = query.billing === 'annual' ? 'annual' : query.billing === 'monthly' ? 'monthly' : subscriptionInterval ?? 'monthly';
  const intent = query.intent && Object.hasOwn(INTENT_COPY, query.intent) ? query.intent as PlanLimitKind : undefined;
  const requestedPlan = (['operator', 'premium', 'agency', 'enterprise'] as const).find(id => id === query.plan)
    ?? (intent ? recommendedUpgradePlan(entitlement.plan.id) : undefined);
  const queryPath = (billing: BillingInterval) => '/dashboard/billing?' + new URLSearchParams({ billing, projectId: tenant.organizationId, ...(requestedPlan ? { plan: requestedPlan } : {}), ...(intent ? { intent } : {}) });
  const setupDestination = requestedPlan && !hasSubscription ? queryPath(interval) : '/dashboard';
  const canManageOrganization = ['owner', 'admin'].includes(tenant.organizationRole);
  const projectUsage = canManageOrganization ? (await listOrganizationProjects(tenant.userId, tenant.organizationGroupId)).filter(project => !project.archivedAt) : undefined;
  const actions: Partial<Record<PaidPlanId, React.ReactNode>> = {};
  const notes: Partial<Record<PaidPlanId, React.ReactNode>> = {};
  const primaryPlan = requestedPlan ?? recommendedUpgradePlan(entitlement.plan.id);
  for (const id of PAID_PLAN_IDS) {
    const selected = entitlement.plan.id === id && (!hasSubscription || !subscriptionInterval || interval === subscriptionInterval);
    const scheduled = details?.scheduled?.planId === id && details.scheduled.interval === interval;
    const ready = billingPlanConfigured(id, interval);
    const className = 'pricing-action' + (primaryPlan === id ? ' pricing-action-primary' : '');
    const changeLabel = planChangeLabel(entitlement.plan.id, id, interval);
    if (scheduled) actions[id] = <span className="pricing-action pricing-action-current">Change scheduled</span>;
    else if (selected) actions[id] = <span className="pricing-action pricing-action-current">Current plan</span>;
    else if (!canManage) actions[id] = <span className="pricing-action pricing-action-current">Owner approval needed</span>;
    else if (hasSubscription && ready) actions[id] = <BillingForm action={changeProjectSubscriptionForm.bind(null, tenant.organizationId, id, interval)} label={changeLabel} pendingLabel="Opening plan change…" className={className} />;
    else if (!hasSubscription && ready && !checkoutPending) actions[id] = <BillingForm action={startProjectSubscriptionForm.bind(null, tenant.organizationId, id, interval)} label={complimentary ? changeLabel : requestedPlan === id ? `Continue with ${PLANS[id].name}` : trialEligible ? 'Start 7-day free trial' : `Subscribe to ${PLANS[id].name}`} pendingLabel="Opening checkout…" className={className} />;
    else actions[id] = <span className="pricing-action pricing-action-current">{checkoutPending ? 'Confirming your plan…' : 'Checkout unavailable'}</span>;
    notes[id] = scheduled ? `Starts ${formatDate(details!.scheduled!.startsAt)}` : selected ? complimentary ? 'Complimentary access' : subscriptionInterval ? `Billed ${subscriptionInterval === 'annual' ? 'yearly' : 'monthly'}` : 'Your current plan'
      : !canManage ? 'Your organization owner can change plans.' : hasSubscription ? 'Review the price and effective date in Stripe.' : complimentary ? 'Review the price in Stripe before subscribing.' : trialEligible ? '7-day free trial · cancel anytime' : 'Cancel anytime';
  }
  let freeAction: React.ReactNode;
  if (canManage && entitlement.plan.id !== 'reader') {
    if (hasSubscription && configured) freeAction = entitlement.cancelAtPeriodEnd || entitlement.cancelAt
      ? <span className="pricing-action pricing-action-current">Cancellation scheduled</span>
      : <BillingForm action={changeProjectSubscriptionForm.bind(null, tenant.organizationId, 'reader', interval)} label="Downgrade to Free" pendingLabel="Opening cancellation…" className="pricing-action" />;
    else if (complimentary && !entitlement.providerCustomerId) freeAction = <BillingForm action={changeProjectSubscriptionForm.bind(null, tenant.organizationId, 'reader', interval)} label="Switch to Free" pendingLabel="Switching…" className="pricing-action" confirmation={{ title: 'Switch to Free?', description: 'Your complimentary access will end. Free includes 3 active ad accounts, read-only ad tools, and 30 days of audit history. Your campaigns keep running.', confirmLabel: 'Switch to Free' }} />;
  }
  const pricing = <div className="dashboard-pricing">
    <PricingComparison variant="dashboard" currentPlanId={entitlement.plan.id} requestedPlan={requestedPlan} interval={interval} billingLinks={{ monthly: queryPath('monthly'), annual: queryPath('annual') }} actions={actions} notes={notes} canManageBilling={canManage} freeAction={freeAction} freeNote={hasSubscription ? 'Review the end date in Stripe before confirming.' : complimentary ? 'Your current access stays until you confirm.' : undefined}
      context={intent ? <div className="paywall-context"><p>{INTENT_COPY[intent]} {requestedPlan ? `${PLANS[requestedPlan].name} is recommended for this request.` : ''}</p></div> : undefined} />
  </div>;
  return <main className="page plan-page">
    <PageHeader title="Plan & billing" description="One subscription covers every project in your organization. Active accounts and editing-member allowances are shared across projects. Read-only viewers are free." action={!tenant.onboardingCompletedAt && canManage ? <Link className="button secondary" href={'/onboarding?resume=1&return_to=' + encodeURIComponent(setupDestination)}>Continue setup</Link> : undefined} />
    {query.checkout === 'complete' ? <CheckoutStatus ready={subscriptionReady} planName={entitlement.plan.name} /> : null}
    {query.checkout === 'canceled' ? <div className="callout plan-notice">Checkout was canceled. Your current plan is unchanged.</div> : null}
    <section className="plan-summary"><div><span className="plan-kicker">{tenant.organizationGroupName}</span><div className="plan-current-line"><strong>{entitlement.plan.name}</strong><span className={`status ${lifecycle.tone}`}>{complimentary ? 'Complimentary' : lifecycle.label}</span></div><p>Shared across every project in your organization.</p>{lifecycle.message ? <p role="status">{lifecycle.message}</p> : hasSubscription ? <p>Your existing subscription keeps its current price until you confirm a change in Stripe. Review the price and effective date before confirming.</p> : complimentary ? <p>Your current access is complimentary. Choosing another paid plan starts a subscription at the price shown.</p> : null}</div>{entitlement.providerCustomerId && canManage && configured ? <BillingForm action={openProjectBillingPortalForm.bind(null, tenant.organizationId)} label="Manage billing" pendingLabel="Opening billing…" className="button secondary" /> : null}</section>
    {details?.scheduled ? <p className="inline-note" role="status">{details.scheduled.name}{details.scheduled.interval ? `, billed ${details.scheduled.interval === 'annual' ? 'yearly' : 'monthly'},` : ''} starts {formatDate(details.scheduled.startsAt)}. Your {entitlement.plan.name} access stays active until then. You can review the scheduled change in Manage billing.</p> : null}
    {!canManage ? <p className="upgrade-owner-note">Only your organization owner can change plans. Share the plan details with them to request an upgrade.</p> : null}
    {intent ? pricing : null}
    <PlanUsage plan={entitlement.plan} usage={usage} organizationName={tenant.organizationGroupName} canManage={canManageOrganization} projectUsage={projectUsage} currentProjectId={tenant.organizationId} />
    {entitlement.plan.maxMembers !== null && usage.editingMembers > entitlement.plan.maxMembers ? <div className="callout plan-notice" role="status">Your organization has {usage.editingMembers} editing members and this plan includes {entitlement.plan.maxMembers}. Extra editors have read-only ad access. Set teammates to Viewer in Organization settings or upgrade to restore their editing access.</div> : null}
    {!intent ? pricing : null}
    {!configured ? <p className="inline-note">Online billing is currently unavailable. Contact support to change plans.</p> : null}
  </main>;
}
