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

export const metadata = { title: 'Plan' };

const PLAN_ORDER: PlanId[] = ['reader', 'operator', 'agency'];

const PLAN_COPY: Record<PlanId, { eyebrow: string; description: string }> = {
  reader: {
    eyebrow: 'Explore',
    description: 'Connect your accounts and use every reporting surface without granting an agent write access.',
  },
  operator: {
    eyebrow: 'Operate',
    description: 'For an owner or small team running campaigns with preview-before-apply safety.',
  },
  agency: {
    eyebrow: 'Scale',
    description: 'For teams managing more accounts, collaborators, client workspaces, and longer audit history.',
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
  const configured = billingConfigured();
  const canManage = tenant.role === 'owner';
  const interval: BillingInterval = query.billing === 'annual' ? 'annual' : 'monthly';

  return (
    <main className="page plan-page">
      <PageHeader
        title="Choose how you operate"
        description="Connect ad accounts once, then use the same governed workspace from ChatGPT, Codex, Claude Code, REST, and the dashboard."
      />
      {query.checkout === 'complete' ? <div className="callout success plan-notice">Checkout completed. Stripe is confirming the subscription through the signed webhook.</div> : null}
      {query.checkout === 'canceled' ? <div className="callout plan-notice">Checkout was canceled. Your current plan is unchanged.</div> : null}

      <section className="plan-summary">
        <div>
          <span className="plan-kicker">Current workspace</span>
          <div className="plan-current-line">
            <strong>{entitlement.plan.name}</strong>
            <span className="status">{entitlement.status.replaceAll('_', ' ')}</span>
          </div>
          <p>Agent access follows the plan and member role. Checkout and upgrade prompts never appear inside agent responses.</p>
        </div>
        {entitlement.providerCustomerId && canManage && configured ? (
          <form action={openBillingPortal}><button className="button secondary" type="submit">Manage billing</button></form>
        ) : null}
      </section>

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
          const paid = plan.id === 'operator' || plan.id === 'agency';
          const paidPlanReady = plan.id === 'operator' || plan.id === 'agency'
            ? billingPlanConfigured(plan.id, interval)
            : false;
          const annual = interval === 'annual' && paid;
          const displayPrice = annual ? Math.round((plan.annualPriceEur! / 12) * 100) / 100 : plan.monthlyPriceEur;
          const annualSaving = paid ? (plan.monthlyPriceEur! * 12) - plan.annualPriceEur! : 0;

          return (
            <section className={`plan-card${plan.id === 'operator' ? ' featured' : ''}${selected ? ' selected' : ''}`} key={plan.id}>
              <div className="plan-card-top">
                <span className="plan-kicker">{PLAN_COPY[plan.id].eyebrow}</span>
                {plan.id === 'operator' ? <span className="plan-badge">Most popular</span> : selected ? <span className="plan-badge neutral">Current plan</span> : null}
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
                  </>
                )}
              </div>
              <ul className="plan-features">
                <li>{formatPlanLimit(plan.maxActiveAccounts, 'active ad accounts')}</li>
                <li>{formatPlanLimit(plan.maxMembers, 'workspace members')}</li>
                <li>{plan.maxRetentionDays}-day audit history</li>
                <li>{plan.writeAccess ? 'Guarded read and write tools' : 'Read-only tools across every agent client'}</li>
                {plan.clientWorkspaces ? <li>Separate client workspaces</li> : null}
              </ul>
              <div className="plan-action">
                {selected ? <span className="button secondary full disabled">Current plan</span> : null}
                {!selected && paid && canManage && paidPlanReady && !entitlement.providerSubscriptionId ? (
                  <form action={startSubscription.bind(null, plan.id, interval)}>
                    <button className="button full" type="submit">Choose {plan.name}</button>
                  </form>
                ) : null}
                {!selected && paid && configured && !paidPlanReady ? <span className="plan-unavailable">Checkout coming soon</span> : null}
                {!selected && paid && !canManage ? <span className="plan-unavailable">Ask the workspace owner to change plans</span> : null}
                {!selected && paid && entitlement.providerSubscriptionId ? <span className="plan-unavailable">Manage changes in the billing portal</span> : null}
              </div>
            </section>
          );
        })}
      </div>

      <section className="enterprise-card">
        <div>
          <span className="plan-kicker">{PLAN_COPY.enterprise.eyebrow}</span>
          <h2>Enterprise</h2>
          <p>{PLAN_COPY.enterprise.description} Includes SSO, regional hosting, custom retention, SLA, and dedicated onboarding.</p>
        </div>
        <a className="button secondary" href="mailto:yannick@adport.dev?subject=Adport%20Enterprise">Talk to Adport</a>
      </section>
      {!configured ? <p className="inline-note" style={{ marginTop: '0.9rem' }}>Online billing is not configured in this environment. Plan entitlements still fail closed to Free.</p> : null}
    </main>
  );
}
