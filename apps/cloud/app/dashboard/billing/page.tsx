import { Button } from '@/components/controls';
import { PageHeader } from '@/components/ui';
import { billingConfigured, billingPlanConfigured } from '@/lib/cloud/billing';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import {
  formatPlanLimit,
  getOrganizationEntitlement,
  PLANS,
  type BillingInterval,
  type PlanId,
} from '@/lib/cloud/plans';
import { openBillingPortal, startSubscription } from './actions';
import { editingMemberCapacity } from '@/lib/cloud/member-capacity';

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
  searchParams: Promise<{ checkout?: string; billing?: string }>;
}) {
  const [tenant, query] = await Promise.all([requireDashboardTenant(), searchParams]);
  const entitlement = await getOrganizationEntitlement(tenant.organizationId);
  const editingMembers = await editingMemberCapacity(tenant.organizationId);
  const configured = billingConfigured();
  const canManage = tenant.organizationRole === 'owner';
  const hasSubscription = Boolean(entitlement.providerSubscriptionId && entitlement.status !== 'canceled');
  const trialEligible = !entitlement.providerSubscriptionId;
  const interval: BillingInterval = query.billing === 'annual' ? 'annual' : 'monthly';

  return (
    <main className="page plan-page">
      <PageHeader
        title="Plan & billing"
        description="One subscription covers every project in your organization. Active accounts and editing-member allowances are shared across projects. Read-only viewers are free."
      />
      {query.checkout === 'complete' ? <div className="callout success plan-notice" role="status">Checkout complete. Your plan is being updated.</div> : null}
      {query.checkout === 'canceled' ? <div className="callout plan-notice">Checkout was canceled. Your current plan is unchanged.</div> : null}

      <section className="plan-summary">
        <div>
          <span className="plan-kicker">{tenant.organizationGroupName}</span>
          <div className="plan-current-line">
            <strong>{entitlement.plan.name}</strong>
            <span className={`status${['past_due', 'unpaid', 'incomplete'].includes(entitlement.status) ? ' warn' : entitlement.status === 'canceled' ? ' neutral' : ''}`}>{entitlement.status === 'canceled' ? 'Free access' : entitlement.status.replaceAll('_', ' ')}</span>
          </div>
          <p>Shared across every project in your organization.</p>
          {hasSubscription ? <p>Your existing subscription keeps its current price until you choose a change in the billing portal.</p> : null}
        </div>
        {entitlement.providerCustomerId && canManage && configured ? (
          <form action={openBillingPortal}><Button className="button secondary" type="submit">Manage billing</Button></form>
        ) : null}
      </section>
      {!canManage ? <p className="inline-note">Only the organization owner can change plans.</p> : null}
      {entitlement.plan.maxMembers !== null && editingMembers.count > entitlement.plan.maxMembers ? <div className="callout plan-notice" role="status">Your organization has {editingMembers.count} editing members and this plan includes {entitlement.plan.maxMembers}. Extra editors have read-only ad access. Set teammates to Viewer in Organization settings or upgrade to restore their editing access.</div> : null}

      <div className="plan-toolbar" aria-label="Billing interval">
        <div className="billing-toggle">
          <a className={interval === 'monthly' ? 'active' : ''} href="?billing=monthly">Monthly</a>
          <a className={interval === 'annual' ? 'active' : ''} href="?billing=annual">Yearly</a>
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
            <section className={`plan-card${plan.id === 'premium' ? ' featured' : ''}${selected ? ' selected' : ''}`} key={plan.id}>
              <div className="plan-card-top">
                <span className="plan-kicker">{PLAN_COPY[plan.id].eyebrow}</span>
                {selected ? <span className="plan-badge neutral">Current plan</span> : plan.id === 'premium' ? <span className="plan-badge">Best value</span> : null}
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
                {!selected && paid && canManage && paidPlanReady && !hasSubscription ? (
                  <form action={startSubscription.bind(null, plan.id, interval)}>
                    <Button className="button full" type="submit">{trialEligible ? 'Start 7-day free trial' : 'Subscribe'}</Button>
                  </form>
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
      {!configured ? <p className="inline-note" style={{ marginTop: '0.9rem' }}>Online billing is currently unavailable. Contact support to change plans.</p> : null}
    </main>
  );
}
