import { DashboardLink as Link } from '@/components/dashboard-navigation';
import { billingConfigured, billingPlanConfigured } from '@/lib/cloud/billing';
import { billingStatus } from '@/lib/billing-status';
import { BillingForm } from './billing-form';
import { CheckoutStatus } from './checkout-status';
import { PageHeader, formatDate } from '@/components/ui';
import { PlanUsage } from '@/components/plan-usage';
import { PAID_PLAN_IDS, type PaidPlanId } from '@/components/pricing-comparison';
import { DashboardPricing } from '@/components/dashboard-pricing';
import { getOrganizationUsage } from '@/lib/cloud/usage';
import { listOrganizationProjects } from '@/lib/cloud/workspaces';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { getOrganizationEntitlement, PLANS, subscriptionEnded, recommendedUpgradePlan, type BillingInterval } from '@/lib/cloud/plans';
import { PLAN_LIMIT_TITLES, type PlanLimitKind, type UpgradePlanId } from '@/lib/cloud/plan-limit';
import { changeProjectSubscriptionForm, openProjectBillingPortalForm, startProjectSubscriptionForm } from './actions';
import { selectProjectAction } from '../projects/actions';
import { Button } from '@/components/controls';
import { currentBillingDetails } from '@/lib/cloud/billing-plan-changes';
import { planChangeLabel, trialEligible as canStartTrial } from '@/lib/plan-change';

export const metadata = { title: 'Plan' };

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string; billing?: string; plan?: string; intent?: string; projectId?: string; view?: string }> }) {
  const [tenant, query] = await Promise.all([requireDashboardTenant(), searchParams]);
  if (query.projectId && !tenant.projects.some(project => project.id === query.projectId && project.organizationId === tenant.organizationGroupId)) {
    const target = tenant.projects.find(project => project.id === query.projectId);
    const destination = '/dashboard/billing?' + new URLSearchParams({
      ...(query.plan ? { plan: query.plan } : {}), ...(query.intent ? { intent: query.intent } : {}),
      ...(query.billing === 'annual' ? { billing: 'annual' } : {}),
      ...(query.view === 'plans' ? { view: 'plans' } : {}),
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
  const intent = query.intent && Object.hasOwn(PLAN_LIMIT_TITLES, query.intent) ? query.intent as PlanLimitKind : undefined;
  const requestedPlan = (['operator', 'premium', 'agency', 'enterprise'] as const).find(id => id === query.plan)
    ?? (intent ? recommendedUpgradePlan(entitlement.plan.id) : undefined);
  const showPlans = Boolean(intent || requestedPlan || query.view === 'plans' || query.billing === 'annual' || query.billing === 'monthly');
  const queryPath = (billing: BillingInterval) => '/dashboard/billing?' + new URLSearchParams({ billing, projectId: tenant.organizationId, view: 'plans', ...(requestedPlan ? { plan: requestedPlan } : {}), ...(intent ? { intent } : {}) });
  const canManageOrganization = ['owner', 'admin'].includes(tenant.organizationRole);
  const resumeSetup = !tenant.onboardingCompletedAt && canManageOrganization
    && (query.checkout === 'complete' || query.checkout === 'canceled' || Boolean(requestedPlan));
  const projectUsage = canManageOrganization ? (await listOrganizationProjects(tenant.userId, tenant.organizationGroupId)).filter(project => !project.archivedAt) : undefined;
  const actions: Record<BillingInterval, Partial<Record<PaidPlanId, React.ReactNode>>> = { monthly: {}, annual: {} };
  const notes: Record<BillingInterval, Partial<Record<PaidPlanId, React.ReactNode>>> = { monthly: {}, annual: {} };
  const primaryPlan = requestedPlan ?? recommendedUpgradePlan(entitlement.plan.id);
  for (const optionInterval of ['monthly', 'annual'] as const) {
    for (const id of PAID_PLAN_IDS) {
      const selected = entitlement.plan.id === id && (!hasSubscription || !subscriptionInterval || optionInterval === subscriptionInterval);
      const scheduled = details?.scheduled?.planId === id && details.scheduled.interval === optionInterval;
      const ready = billingPlanConfigured(id, optionInterval);
      const className = 'pricing-action' + (primaryPlan === id ? ' pricing-action-primary' : '');
      const changeLabel = planChangeLabel(entitlement.plan.id, id, optionInterval);
      if (scheduled) actions[optionInterval][id] = <span className="pricing-action pricing-action-current">Change scheduled</span>;
      else if (selected) actions[optionInterval][id] = <span className="pricing-action pricing-action-current">Current plan</span>;
      else if (!canManage) actions[optionInterval][id] = <span className="pricing-action pricing-action-current">Owner approval needed</span>;
      else if (hasSubscription && ready) actions[optionInterval][id] = <BillingForm action={changeProjectSubscriptionForm.bind(null, tenant.organizationId, id, optionInterval)} label={changeLabel} pendingLabel="Opening plan change…" className={className} />;
      else if (!hasSubscription && ready && !checkoutPending) actions[optionInterval][id] = <BillingForm action={startProjectSubscriptionForm.bind(null, tenant.organizationId, id, optionInterval)} label={complimentary ? changeLabel : requestedPlan === id ? `Continue with ${PLANS[id].name}` : trialEligible ? 'Start 7-day free trial' : `Subscribe to ${PLANS[id].name}`} pendingLabel="Opening checkout…" className={className} />;
      else actions[optionInterval][id] = <span className="pricing-action pricing-action-current">{checkoutPending ? 'Confirming your plan…' : 'Checkout unavailable'}</span>;
      notes[optionInterval][id] = scheduled ? `Starts ${formatDate(details!.scheduled!.startsAt)}` : selected ? complimentary ? 'Complimentary access' : subscriptionInterval ? `Billed ${subscriptionInterval === 'annual' ? 'yearly' : 'monthly'}` : 'Your current plan'
        : !canManage ? 'Your organization owner can change plans.' : hasSubscription ? 'Review the price and effective date in Stripe.' : complimentary ? 'Review the price in Stripe before subscribing.' : trialEligible ? '7-day free trial · cancel anytime' : 'Cancel anytime';
    }
  }
  let freeAction: React.ReactNode;
  if (canManage && entitlement.plan.id !== 'reader') {
    if (hasSubscription && configured) freeAction = entitlement.cancelAtPeriodEnd || entitlement.cancelAt
      ? <span className="pricing-action pricing-action-current">Cancellation scheduled</span>
      : <BillingForm action={changeProjectSubscriptionForm.bind(null, tenant.organizationId, 'reader', interval)} label="Downgrade to Free" pendingLabel="Opening cancellation…" className="pricing-action" />;
    else if (complimentary && !entitlement.providerCustomerId) freeAction = <BillingForm action={changeProjectSubscriptionForm.bind(null, tenant.organizationId, 'reader', interval)} label="Switch to Free" pendingLabel="Switching…" className="pricing-action" confirmation={{ title: 'Switch to Free?', description: 'Your complimentary access will end. Free includes 3 active ad accounts, read-only ad tools, and 30 days of audit history. Your campaigns keep running.', confirmLabel: 'Switch to Free' }} />;
  }
  const pricing = <div className="billing-plans" id="plans"><DashboardPricing key={`${tenant.organizationId}:${interval}`} currentPlanId={entitlement.plan.id} requestedPlan={requestedPlan} initialInterval={interval} billingLinks={{ monthly: queryPath('monthly'), annual: queryPath('annual') }} actions={actions} notes={notes} canManageBilling={canManage} freeAction={freeAction}
    context={intent ? <div className="paywall-context"><p><strong>{PLAN_LIMIT_TITLES[intent]}</strong>{requestedPlan && requestedPlan !== entitlement.plan.id ? ` · ${PLANS[requestedPlan].name} was selected for this request.` : ''}</p></div> : undefined} /></div>;
  return <main className="page plan-page">
    <PageHeader title="Plan & billing" description="One subscription covers every project in your organization. Read-only viewers are free." action={<>
      {resumeSetup ? <Link className="button secondary" href="/onboarding?resume=1&return_to=%2Fdashboard">Continue setup</Link> : null}
      {showPlans ? <Link className="button secondary" href="/dashboard/billing#usage">Back to usage</Link>
        : <Link className="button secondary" href={queryPath(interval) + '#plans'}>Compare plans</Link>}
    </>} />
    {query.checkout === 'complete' || query.checkout === 'canceled' ? <CheckoutStatus status={query.checkout === 'canceled' ? 'canceled' : subscriptionReady ? 'ready' : 'pending'} planName={entitlement.plan.name} /> : null}
    <section className="plan-summary"><div><span className="plan-kicker">{tenant.organizationGroupName}</span><div className="plan-current-line"><strong>{entitlement.plan.name}</strong><span className={`status ${lifecycle.tone}`}>{complimentary ? 'Complimentary' : lifecycle.label}</span></div>{lifecycle.message ? <p role="status">{lifecycle.message}</p> : hasSubscription && entitlement.currentPeriodEnd ? <p>{entitlement.status === 'trialing' ? 'Trial ends' : 'Current period ends'} {formatDate(entitlement.currentPeriodEnd)}.</p> : null}</div>{entitlement.providerCustomerId && canManage && configured ? <BillingForm action={openProjectBillingPortalForm.bind(null, tenant.organizationId)} label="Manage billing" pendingLabel="Opening billing…" className="button secondary" /> : null}</section>
    {details?.scheduled ? <p className="inline-note" role="status">{details.scheduled.name}{details.scheduled.interval ? `, billed ${details.scheduled.interval === 'annual' ? 'yearly' : 'monthly'},` : ''} starts {formatDate(details.scheduled.startsAt)}. Your {entitlement.plan.name} access stays active until then. You can review the scheduled change in Manage billing.</p> : null}
    {!canManage ? <p className="upgrade-owner-note">Only your organization owner can change plans. Share the plan details with them to request an upgrade.</p> : null}
    {showPlans ? pricing : null}
    <PlanUsage plan={entitlement.plan} usage={usage} organizationName={tenant.organizationGroupName} canManage={canManageOrganization} projectUsage={projectUsage} currentProjectId={tenant.organizationId} />
    {entitlement.plan.maxMembers !== null && usage.editingMembers > entitlement.plan.maxMembers ? <div className="callout plan-notice" role="status">Your organization has {usage.editingMembers} editing members and this plan includes {entitlement.plan.maxMembers}. Extra editors have read-only ad access. Set teammates to Viewer in Organization settings or upgrade to restore their editing access.</div> : null}
    {!configured ? <p className="inline-note">Online billing is currently unavailable. Contact support to change plans.</p> : null}
  </main>;
}
