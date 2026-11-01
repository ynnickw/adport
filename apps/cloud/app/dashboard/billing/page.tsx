import { Disclosure } from '@/components/controls';
import { BillingForm } from './billing-form';
import { PlanUsage } from '@/components/plan-usage';
import { getOrganizationUsage } from '@/lib/cloud/usage';
import Link from 'next/link';
import { CheckoutStatus } from './checkout-status';
import { billingStatus } from '@/lib/billing-status';
import { listOrganizationProjects } from '@/lib/cloud/workspaces';
import { PageHeader } from '@/components/ui';
import { billingConfigured, billingPlanConfigured } from '@/lib/cloud/billing';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import {
  formatPlanLimit,
  getOrganizationEntitlement,
  PLANS,
  subscriptionEnded,
  type BillingInterval,
  type PlanId,
} from '@/lib/cloud/plans';
import { openBillingPortalForm, startSubscriptionForm } from './actions';

export const metadata = { title: 'Plan' };

const PLAN_ORDER: PlanId[] = ['reader', 'operator', 'premium', 'agency'];

const PLAN_COPY: Record<PlanId, { eyebrow: string; description: string }> = {
  reader: {
    eyebrow: 'Explore',
    description: 'Connect your accounts and use every reporting surface without granting an agent write access.',
  },
  operator: {
    eyebrow: 'Operate',
    description: 'For an owner or small team running campaigns with preview-before-apply safety.',
  },
  premium: {
    eyebrow: 'Grow',
    description: 'For freelancers and growing teams managing several brands or clients.',
  },
  agency: {
    eyebrow: 'Scale',
    description: 'For agencies coordinating client accounts, editing teams, and two years of audit history.',
  },
  enterprise: {
    eyebrow: 'Customize',
    description: 'For larger organizations with security, residency, support, and migration requirements.',
  },
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; billing?: string; plan?: string; intent?: string; compare?: string }>;
}) {
  const [tenant, query] = await Promise.all([requireDashboardTenant(), searchParams]);
  const entitlement = await getOrganizationEntitlement(tenant.organizationId);
  const usage = await getOrganizationUsage(tenant.organizationId);
  const configured = billingConfigured();
  const canManage = tenant.organizationRole === 'owner';
  const hasSubscription = Boolean(entitlement.providerSubscriptionId && !subscriptionEnded(entitlement.status));
  const lifecycle = billingStatus(entitlement);
  const subscriptionReady = hasSubscription && ['active', 'trialing', 'past_due'].includes(entitlement.status);
  const checkoutPending = query.checkout === 'complete' && !subscriptionReady;
  const trialEligible = !entitlement.providerSubscriptionId;
  const interval: BillingInterval = query.billing === 'annual' ? 'annual' : 'monthly';
  const requestedPlan = (['operator', 'premium', 'agency'] as const).find(id => id === query.plan);
  const compareOpen = Boolean(query.intent || query.compare === '1');
  const setupDestination = requestedPlan && !hasSubscription ? '/dashboard/billing?' + new URLSearchParams({ plan: requestedPlan, billing: interval }) : '/dashboard';
  const requested = requestedPlan ? PLANS[requestedPlan] : undefined;
  const canManageOrganization = ['owner', 'admin'].includes(tenant.organizationRole);
  const projectUsage = canManageOrganization ? (await listOrganizationProjects(tenant.userId, tenant.organizationGroupId)).filter(project => !project.archivedAt) : undefined;

  return (
    <main className="page plan-page">
      <PageHeader
        title="Plan & billing"
        description="One subscription covers every project in your organization. Active accounts and editing-member allowances are shared across projects. Read-only viewers are free."
        action={!tenant.onboardingCompletedAt && canManage ? <Link className="button secondary" href={'/onboarding?return_to=' + encodeURIComponent(setupDestination)}>Continue setup</Link> : undefined}
      />
      {query.checkout === 'complete' ? <CheckoutStatus ready={subscriptionReady} planName={entitlement.plan.name} /> : null}
      {query.checkout === 'canceled' ? <div className="callout plan-notice">Checkout was canceled. Your current plan is unchanged.</div> : null}
      {requested && requestedPlan && entitlement.plan.id !== requestedPlan ? <section className="requested-subscription" aria-label="Selected subscription">
        <div><span className="plan-kicker">{query.intent ? 'Recommended plan' : 'Your choice'}</span><h2>{requested.name} <span>{interval === 'annual' ? '€' + requested.annualPriceEur + ' / year' : '€' + requested.monthlyPriceEur + ' / month'}</span></h2><p>{requested.maxActiveAccounts} enabled accounts · {requested.maxMembers} team seats · Unlimited projects</p>{!hasSubscription && trialEligible ? <small>7-day free trial, then {interval === 'annual' ? 'yearly' : 'monthly'} billing</small> : null}</div>
        {canManage && billingPlanConfigured(requestedPlan, interval) && !checkoutPending ? <BillingForm action={hasSubscription ? openBillingPortalForm : startSubscriptionForm.bind(null, requestedPlan, interval)} label={hasSubscription ? 'Manage billing' : 'Continue with ' + requested.name} pendingLabel={hasSubscription ? 'Opening billing…' : 'Opening checkout…'} className="button" /> : !canManage ? <span className="inline-note">Only your organization owner can confirm this plan.</span> : null}
      </section> : null}

      <section className="plan-summary">
        <div>
          <span className="plan-kicker">{tenant.organizationGroupName}</span>
          <div className="plan-current-line">
            <strong>{entitlement.plan.name}</strong>
            <span className={`status ${lifecycle.tone}`}>{lifecycle.label}</span>
          </div>
          <p>Shared across every project in your organization.</p>
          {lifecycle.message ? <p role="status">{lifecycle.message}</p> : hasSubscription ? <p>Your existing subscription keeps its current price until you choose a change in the billing portal.</p> : null}
        </div>
        {entitlement.providerCustomerId && canManage && configured ? (
          <BillingForm action={openBillingPortalForm} label="Manage billing" pendingLabel="Opening billing…" className="button secondary" />
        ) : null}
      </section>
      {!canManage ? <p className="inline-note">Only the organization owner can change plans.</p> : null}
      <PlanUsage plan={entitlement.plan} usage={usage} organizationName={tenant.organizationGroupName} canManage={canManageOrganization} projectUsage={projectUsage} currentProjectId={tenant.organizationId} />
      {entitlement.plan.maxMembers !== null && usage.editingMembers > entitlement.plan.maxMembers ? <div className="callout plan-notice" role="status">Your organization has {usage.editingMembers} editing members and this plan includes {entitlement.plan.maxMembers}. Extra editors have read-only ad access. Set teammates to Viewer in Organization settings or upgrade to restore their editing access.</div> : null}

      <Disclosure label="Compare plans" open={compareOpen} className="plan-comparison" key={String(compareOpen)}>
      <div className="plan-toolbar" aria-label="Billing interval">
        <div className="billing-toggle">
          <a className={interval === 'monthly' ? 'active' : ''} href={'?billing=monthly&compare=1' + (requestedPlan ? '&plan=' + requestedPlan : '')}>Monthly</a>
          <a className={interval === 'annual' ? 'active' : ''} href={'?billing=annual&compare=1' + (requestedPlan ? '&plan=' + requestedPlan : '')}>Yearly</a>
        </div>
        <span className="annual-saving">Yearly includes two months free</span>
      </div>

      <div className="plan-grid">
        {PLAN_ORDER.map((planId) => {
          const plan = PLANS[planId];
          const selected = entitlement.plan.id === planId;
          const paid = plan.id === 'operator' || plan.id === 'premium' || plan.id === 'agency';
          const paidPlanReady = plan.id === 'operator' || plan.id === 'premium' || plan.id === 'agency'
            ? billingPlanConfigured(plan.id, interval)
            : false;
          const annual = interval === 'annual' && paid;
          const displayPrice = annual ? (plan.annualPriceEur! / 12).toFixed(2) : plan.monthlyPriceEur;
          const annualSaving = paid ? (plan.monthlyPriceEur! * 12) - plan.annualPriceEur! : 0;

          return (
            <section className={`plan-card${plan.id === 'premium' ? ' featured' : ''}${selected ? ' selected' : ''}${requestedPlan === plan.id ? ' requested' : ''}`} key={plan.id}>
              <div className="plan-card-top">
                <span className="plan-kicker">{PLAN_COPY[plan.id].eyebrow}</span>
                {selected ? <span className="plan-badge neutral">Current plan</span> : requestedPlan === plan.id ? <span className="plan-badge">Your choice</span> : plan.id === 'premium' ? <span className="plan-badge">Best value</span> : null}
                <h2>{plan.name}</h2>
                <p>{PLAN_COPY[plan.id].description}</p>
              </div>
              <div className="plan-price">
                {plan.monthlyPriceEur === 0 ? (
                  <><strong>€0</strong><span>forever</span></>
                ) : (
                  <>
                    <strong>€{displayPrice}</strong><span>/ month</span>
                    {annual ? <small>€{plan.annualPriceEur} billed yearly · save €{annualSaving}</small> : <small>Billed monthly</small>}
                    <small className="plan-trial">{trialEligible ? '7-day free trial · cancel anytime' : 'Cancel anytime'}</small>
                  </>
                )}
              </div>
              <ul className="plan-features">
                <li>{formatPlanLimit(plan.maxActiveAccounts, 'active ad accounts')}</li>
                <li>{formatPlanLimit(plan.maxMembers, plan.writeAccess ? 'editing members' : 'members')}</li>
                <li>{plan.maxRetentionDays}-day audit history</li>
                <li>{plan.writeAccess ? 'Guarded read and write tools' : 'Read-only tools across every agent client'}</li>
              </ul>
              <div className="plan-action">
                {selected ? <span className="button secondary full disabled">Current plan</span> : null}
                {!selected && paid && canManage && paidPlanReady && !hasSubscription && !checkoutPending ? (
                  <BillingForm action={startSubscriptionForm.bind(null, plan.id, interval)} label={requestedPlan === plan.id ? 'Continue with ' + plan.name : trialEligible ? 'Start 7-day free trial' : 'Subscribe'} pendingLabel="Opening checkout…" className="button full" />
                ) : null}
                {!selected && paid && configured && !paidPlanReady ? <span className="plan-unavailable">Checkout coming soon</span> : null}
                {!selected && paid && canManage && hasSubscription ? <span className="plan-unavailable">Change plans in Manage billing</span> : null}
              </div>
            </section>
          );
        })}
      </div>
      <p className="inline-note plan-shared-features">Every plan includes unlimited projects, free read-only client viewers, and MCP, CLI, REST, and dashboard access.</p>

      <section className="enterprise-card">
        <div>
          <span className="plan-kicker">{PLAN_COPY.enterprise.eyebrow}</span>
          <h2>Enterprise</h2>
          <p>Need more than 60 active accounts or 15 editing members? Talk to us about a custom organization plan.</p>
        </div>
        <a className="button secondary" href="mailto:yannick@adport.dev?subject=Adport%20Enterprise">Talk to Adport</a>
      </section>
      <p className="inline-note" style={{ marginTop: '0.9rem' }}>Fixed pricing per organization. No percentage of ad spend. Your AI assistant subscription or model usage is separate.</p>
      </Disclosure>
      {!configured ? <p className="inline-note" style={{ marginTop: '0.9rem' }}>Online billing is currently unavailable. Contact support to change plans.</p> : null}
    </main>
  );
}
