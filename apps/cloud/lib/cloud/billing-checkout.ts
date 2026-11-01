import 'server-only';
import type Stripe from 'stripe';
import type postgres from 'postgres';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { currentStripeSubscription, lockBillingOrganization, stripeClient, stripePriceId } from './billing';
import { getOrganizationEntitlement, subscriptionEnded, type BillingInterval, type PlanId } from './plans';

type PaidPlan = Extract<PlanId, 'operator' | 'premium' | 'agency'>;
interface CheckoutAttempt {
  id: string;
  plan: PaidPlan;
  interval: BillingInterval;
  parameters: Stripe.Checkout.SessionCreateParams;
  sessionId: string | null;
}

async function loadAttempt(sql: postgres.TransactionSql, organizationId: string) {
  const [attempt] = await sql<CheckoutAttempt[]>`
    select id, plan, interval, parameters, session_id from private.billing_checkout_attempts
    where organization_id = ${organizationId}
  `;
  return attempt;
}

async function sessionForAttempt(sql: postgres.TransactionSql, organizationId: string, attempt: CheckoutAttempt) {
  if (attempt.sessionId) return stripeClient().checkout.sessions.retrieve(attempt.sessionId);
  const session = await stripeClient().checkout.sessions.create(attempt.parameters, { idempotencyKey: `adport:checkout:${attempt.id}` });
  await sql`update private.billing_checkout_attempts set session_id = ${session.id} where organization_id = ${organizationId} and id = ${attempt.id}`;
  return session;
}

async function guardExistingSubscription(sql: postgres.TransactionSql, organizationId: string) {
  const entitlement = await getOrganizationEntitlement(organizationId, sql);
  if (entitlement.providerCustomerId) {
    const current = await currentStripeSubscription(entitlement.providerCustomerId, organizationId, entitlement.providerSubscriptionId);
    if (current && !subscriptionEnded(current.status)) throw new Error('Your Stripe subscription already exists. Refresh billing or open the billing portal.');
    if (entitlement.providerSubscriptionId && !current) throw new Error('The existing subscription could not be verified. Open the billing portal.');
  } else if (entitlement.providerSubscriptionId && !subscriptionEnded(entitlement.status)) {
    throw new Error('Manage the existing subscription in the billing portal.');
  }
  return entitlement;
}

async function expireLegacyCheckouts(organizationId: string, customerId: string | null): Promise<void> {
  // Sessions opened before durable attempts were introduced are not in our
  // table. Invalidate matching unpaid sessions before offering a replacement.
  for await (const session of stripeClient().checkout.sessions.list({ status: 'open', limit: 100, ...(customerId ? { customer: customerId } : {}) })) {
    if (session.client_reference_id === organizationId || session.metadata?.organizationId === organizationId) {
      await stripeClient().checkout.sessions.expire(session.id);
    }
  }
}

export async function subscriptionCheckoutUrl(organizationId: string, userId: string, plan: PaidPlan, interval: BillingInterval): Promise<string> {
  // Allocate and commit the attempt before creating a payable session. If the
  // following transaction fails after Stripe responds, the same key survives.
  const prepared = await db().begin(async sql => {
    await lockBillingOrganization(sql, organizationId);
    const entitlement = await guardExistingSubscription(sql, organizationId);
    const previous = await loadAttempt(sql, organizationId);
    if (!previous) await expireLegacyCheckouts(organizationId, entitlement.providerCustomerId);
    if (previous) {
      const expiredUnknownSession = !previous.sessionId && previous.parameters.expires_at && previous.parameters.expires_at <= Date.now() / 1000;
      if (expiredUnknownSession) {
        await expireLegacyCheckouts(organizationId, entitlement.providerCustomerId);
      } else {
        const session = await sessionForAttempt(sql, organizationId, previous);
        if (session.status === 'complete') {
          const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
          const subscription = subscriptionId ? await stripeClient().subscriptions.retrieve(subscriptionId) : undefined;
          if (!subscription || !subscriptionEnded(subscription.status)) throw new Error('Checkout is already complete. Refresh billing while confirmation finishes.');
        }
        if (session.status === 'open' && previous.plan === plan && previous.interval === interval && session.url) return { url: session.url };
        if (session.status === 'open') {
          // Stripe rejects expiration if payment completed meanwhile. In that case
          // the transaction fails instead of opening another payable session.
          await stripeClient().checkout.sessions.expire(session.id);
        }
      }
      await sql`delete from private.billing_checkout_attempts where organization_id = ${organizationId}`;
    }
    let customerId = entitlement.providerCustomerId;
    if (!customerId) {
      const customer = await stripeClient().customers.create({ metadata: { organizationId } }, { idempotencyKey: `adport:billing-customer:${organizationId}` });
      customerId = customer.id;
      await sql`update public.organization_subscriptions set provider_customer_id = ${customerId} where organization_id = ${organizationId}`;
    }
    const baseUrl = env().ADPORT_CLOUD_BASE_URL;
    const parameters: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription', customer: customerId, client_reference_id: organizationId,
      // Expire before Stripe may prune the idempotency key after 24 hours.
      expires_at: Math.floor(Date.now() / 1000) + 23 * 60 * 60,
      line_items: [{ price: stripePriceId(plan, interval), quantity: 1 }],
      billing_address_collection: 'required', allow_promotion_codes: true,
      metadata: { organizationId, plan, interval },
      subscription_data: {
        metadata: { organizationId, plan, interval, analyticsActorUserId: userId },
        ...(entitlement.providerSubscriptionId ? {} : { trial_period_days: 7 }),
      },
      success_url: new URL('/dashboard/billing?checkout=complete', baseUrl).toString(),
      cancel_url: new URL('/dashboard/billing?' + new URLSearchParams({ checkout: 'canceled', plan, billing: interval, compare: '1' }), baseUrl).toString(),
    };
    const [attempt] = await sql<Array<{ id: string }>>`
      insert into private.billing_checkout_attempts (organization_id, plan, interval, parameters)
      values (${organizationId}, ${plan}, ${interval}, ${sql.json(parameters as never)}) returning id
    `;
    if (!attempt) throw new Error('Checkout attempt could not be saved.');
    return { attemptId: attempt.id };
  });
  if (prepared.url) return prepared.url;
  return db().begin(async sql => {
    await lockBillingOrganization(sql, organizationId);
    await guardExistingSubscription(sql, organizationId);
    const attempt = await loadAttempt(sql, organizationId);
    if (!attempt || attempt.id !== prepared.attemptId) throw new Error('Your checkout selection changed. Please try again.');
    const session = await sessionForAttempt(sql, organizationId, attempt);
    if (session.status !== 'open' || !session.url) throw new Error('Checkout is already complete or expired. Refresh billing and try again.');
    return session.url;
  });
}
