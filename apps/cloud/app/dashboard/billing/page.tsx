import { PageHeader } from '@/components/ui';
import { billingConfigured, billingPlanConfigured } from '@/lib/cloud/billing';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { formatPlanLimit, getOrganizationEntitlement, PLANS, type PlanId } from '@/lib/cloud/plans';
import { openBillingPortal, startSubscription } from './actions';

export const metadata = { title: 'Plan' };

const PLAN_ORDER: PlanId[] = ['reader', 'operator', 'agency'];

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const [tenant, query] = await Promise.all([requireDashboardTenant(), searchParams]);
  const entitlement = await getOrganizationEntitlement(tenant.organizationId);
  const configured = billingConfigured();
  const canManage = tenant.role === 'owner';
  return (
    <main className="page">
      <PageHeader title="Plan" description="Cloud plans cover hosted OAuth, active account access, shared governance, and every supported agent client." />
      {query.checkout === 'complete' ? <div className="callout">Checkout completed. Stripe is confirming the subscription through the signed webhook.</div> : null}
      {query.checkout === 'canceled' ? <div className="callout">Checkout was canceled. Your current plan is unchanged.</div> : null}
      <section className="card" style={{ marginBottom: '0.9rem' }}>
        <div className="card-head"><h2>Current plan</h2><span className="status">{entitlement.plan.name}</span></div>
        <div className="card-body">
          <p className="inline-note">Status: {entitlement.status.replaceAll('_', ' ')}. ChatGPT, Codex, Claude Code, REST, and the dashboard are included; agent plugins never contain checkout or upgrade prompts.</p>
          {entitlement.providerCustomerId && canManage && configured ? (
            <form action={openBillingPortal}><button className="button secondary" type="submit">Manage billing</button></form>
          ) : null}
        </div>
      </section>
      <div className="grid-3">
        {PLAN_ORDER.map((planId) => {
          const plan = PLANS[planId];
          const selected = entitlement.plan.id === planId;
          const paidPlanReady = plan.id === 'operator' || plan.id === 'agency'
            ? billingPlanConfigured(plan.id)
            : false;
          return (
            <section className="card" key={plan.id}>
              <div className="card-head"><h2>{plan.name}</h2>{selected ? <span className="status">current</span> : null}</div>
              <div className="card-body stack">
                <strong style={{ fontSize: '1.5rem' }}>{plan.monthlyPriceEur === 0 ? 'Free' : `€${plan.monthlyPriceEur}/month`}</strong>
                <span className="inline-note">{formatPlanLimit(plan.maxActiveAccounts, 'active ad accounts')}</span>
                <span className="inline-note">{formatPlanLimit(plan.maxMembers, 'workspace members')}</span>
                <span className="inline-note">{plan.maxRetentionDays}-day audit retention</span>
                <span className="inline-note">{plan.writeAccess ? 'Guarded read and write tools' : 'Read-only agent tools'}</span>
                {!selected && plan.id !== 'reader' && canManage && paidPlanReady && !entitlement.providerSubscriptionId ? (
                  <form action={startSubscription.bind(null, plan.id)}><button className="button" type="submit">Choose {plan.name}</button></form>
                ) : null}
                {!selected && plan.id !== 'reader' && configured && !paidPlanReady ? (
                  <span className="inline-note">Checkout coming soon</span>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
      <section className="card" style={{ marginTop: '0.9rem' }}>
        <div className="card-head"><h2>Enterprise</h2><span className="card-note">annual agreement</span></div>
        <div className="card-body"><p className="inline-note">SSO, regional hosting, custom retention, SLA, migration, and dedicated onboarding.</p><a className="button secondary" href="mailto:yannick@adport.dev?subject=Adport%20Enterprise">Contact Adport</a></div>
      </section>
      {!configured ? <p className="inline-note" style={{ marginTop: '0.9rem' }}>Online billing is not configured in this environment. Plan entitlements still fail closed to Reader.</p> : null}
    </main>
  );
}
