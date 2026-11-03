import 'server-only';
import type Stripe from 'stripe';
import { env } from '@/lib/env';
import { db } from '@/lib/db';
import { applyOrganizationPlanLimits, lockBillingOrganization, planForPrice, stripeClient, stripePriceId } from './billing';
import { getOrganizationEntitlement, PLANS, subscriptionEnded, type BillingInterval, type OrganizationEntitlement, type PlanId } from './plans';

type TargetPlan = Extract<PlanId, 'reader' | 'operator' | 'premium' | 'agency'>;

export async function endComplimentaryPlan(organizationId: string, userId: string): Promise<void> {
  await db().begin(async sql => {
    await lockBillingOrganization(sql, organizationId);
    const current = await getOrganizationEntitlement(organizationId, sql);
    if (current.billingProvider === 'stripe' || current.providerCustomerId || current.providerSubscriptionId) throw new Error('Stripe billing must be managed in the billing portal.');
    if (current.plan.id === 'reader') return;
    await sql`update public.organization_subscriptions set plan = 'reader', status = 'active', current_period_end = null,
      cancel_at_period_end = false, cancel_at = null, canceled_at = null, cancellation_reason = null
      where organization_id = ${organizationId}`;
    await applyOrganizationPlanLimits(sql, organizationId, 'reader');
    await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary, details)
      values (${organizationId}, ${userId}, 'subscription_updated', 'cloud', 'end_complimentary_plan', '*', 'Owner switched complimentary access to Free', ${sql.json({ previousPlan: current.plan.id, plan: 'reader' } as never)})`;
  });
}

async function ownedSubscription(entitlement: OrganizationEntitlement, organizationId: string) {
  if (!entitlement.providerCustomerId || !entitlement.providerSubscriptionId || subscriptionEnded(entitlement.status)) throw new Error('An existing subscription is required.');
  const subscription = await stripeClient().subscriptions.retrieve(entitlement.providerSubscriptionId);
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  if (customerId !== entitlement.providerCustomerId || (subscription.metadata.organizationId && subscription.metadata.organizationId !== organizationId)) throw new Error('The subscription does not belong to this organization.');
  if (subscriptionEnded(subscription.status)) throw new Error('This subscription has ended.');
  return subscription;
}

export interface BillingDetails {
  interval: BillingInterval | null;
  scheduled?: { planId: PlanId; name: string; interval: BillingInterval | null; startsAt: Date };
}

const billingInterval = (value: string | undefined): BillingInterval | null => value === 'month' ? 'monthly' : value === 'year' ? 'annual' : null;

export async function currentBillingDetails(entitlement: OrganizationEntitlement, organizationId: string): Promise<BillingDetails> {
  const subscription = await ownedSubscription(entitlement, organizationId);
  const current = subscription.items.data[0]?.price;
  const details: BillingDetails = { interval: billingInterval(current?.recurring?.interval) };
  if (subscription.schedule) {
    const schedule = typeof subscription.schedule === 'string' ? await stripeClient().subscriptionSchedules.retrieve(subscription.schedule) : subscription.schedule;
    const phase = schedule.status === 'active' ? schedule.phases.filter(phase => phase.start_date > Date.now() / 1000).sort((a, b) => a.start_date - b.start_date)[0] : undefined;
    const target = phase?.items[0]?.price;
    const priceId = typeof target === 'string' ? target : target?.id;
    const planId = planForPrice(priceId);
    if (phase && priceId && priceId !== current?.id && planId) {
      const price = await stripeClient().prices.retrieve(priceId);
      details.scheduled = { planId, name: PLANS[planId].name, interval: billingInterval(price.recurring?.interval), startsAt: new Date(phase.start_date * 1000) };
    }
  }
  return details;
}

export async function subscriptionPlanChangeUrl(entitlement: OrganizationEntitlement, organizationId: string, target: TargetPlan, interval: BillingInterval): Promise<string> {
  const subscription = await ownedSubscription(entitlement, organizationId);
  const returnUrl = new URL('/dashboard/billing', env().ADPORT_CLOUD_BASE_URL).toString();
  let flow: Stripe.BillingPortal.SessionCreateParams.FlowData;
  if (target === 'reader') {
    flow = { type: 'subscription_cancel', subscription_cancel: { subscription: subscription.id } };
  } else {
    const item = subscription.items.data[0];
    if (subscription.items.has_more || subscription.items.data.length !== 1 || !item || (item.quantity !== undefined && item.quantity !== 1)) throw new Error('This subscription needs a manual billing review.');
    const price = stripePriceId(target, interval);
    if (item.price.id === price) throw new Error('This billing option is already active.');
    flow = { type: 'subscription_update_confirm', subscription_update_confirm: { subscription: subscription.id, items: [{ id: item.id, price, quantity: item.quantity ?? 1 }] } };
  }
  // Stripe presents the effective date, invoice adjustment, and payment
  // confirmation. Creating this session does not modify the subscription.
  const session = await stripeClient().billingPortal.sessions.create({
    customer: entitlement.providerCustomerId!, configuration: env().STRIPE_BILLING_PORTAL_CONFIGURATION_ID,
    return_url: returnUrl, flow_data: flow,
  });
  return session.url;
}
