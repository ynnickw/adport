import 'server-only';
import Stripe from 'stripe';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { PLANS, type PlanId, type SubscriptionStatus } from './plans';

let client: Stripe | undefined;

export function billingConfigured(): boolean {
  const value = env();
  return Boolean(value.STRIPE_SECRET_KEY && value.STRIPE_WEBHOOK_SECRET
    && value.STRIPE_OPERATOR_PRICE_ID && value.STRIPE_AGENCY_PRICE_ID);
}

export function stripeClient(): Stripe {
  const key = env().STRIPE_SECRET_KEY;
  if (!key) throw new Error('Stripe billing is not configured.');
  client ??= new Stripe(key);
  return client;
}

export function stripePriceId(plan: Extract<PlanId, 'operator' | 'agency'>): string {
  const value = env();
  const priceId = plan === 'operator' ? value.STRIPE_OPERATOR_PRICE_ID : value.STRIPE_AGENCY_PRICE_ID;
  if (!priceId) throw new Error(`${plan} Stripe price is not configured.`);
  return priceId;
}

function planForPrice(priceId: string | undefined): PlanId | undefined {
  if (!priceId) return undefined;
  const value = env();
  if (priceId === value.STRIPE_OPERATOR_PRICE_ID) return 'operator';
  if (priceId === value.STRIPE_AGENCY_PRICE_ID) return 'agency';
  return undefined;
}

function subscriptionStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  if (status === 'active') return 'active';
  if (status === 'trialing') return 'trialing';
  if (status === 'past_due') return 'past_due';
  if (status === 'unpaid') return 'unpaid';
  if (status === 'incomplete') return 'incomplete';
  return 'canceled';
}

async function applySubscription(subscription: Stripe.Subscription): Promise<void> {
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const providerSubscriptionId = subscription.id;
  const organizationId = subscription.metadata.organizationId || undefined;
  const item = subscription.items.data[0];
  const plan = planForPrice(item?.price.id);
  const status = subscriptionStatus(subscription.status);
  const currentPeriodEnd = item?.current_period_end ? new Date(item.current_period_end * 1000) : null;

  const targetRows = organizationId
    ? [{ organizationId }]
    : await db()<Array<{ organizationId: string }>>`
        select organization_id from public.organization_subscriptions
        where provider_subscription_id = ${providerSubscriptionId} or provider_customer_id = ${customerId}
        limit 1
      `;
  const target = targetRows[0]?.organizationId;
  if (!target) throw new Error('Stripe subscription is not bound to an Adport organization.');
  if (!plan && status !== 'canceled') throw new Error(`Stripe price ${item?.price.id ?? 'unknown'} is not mapped to an Adport plan.`);

  const appliedPlan = plan ?? 'reader';
  await db().begin(async (sql) => {
    await sql`
      update public.organization_subscriptions set
        plan = ${appliedPlan},
        status = ${status},
        billing_provider = 'stripe',
        provider_customer_id = ${customerId},
        provider_subscription_id = ${providerSubscriptionId},
        current_period_end = ${currentPeriodEnd},
        cancel_at_period_end = ${subscription.cancel_at_period_end}
      where organization_id = ${target}
    `;

    const effectivePlan = ['active', 'trialing', 'past_due'].includes(status) ? appliedPlan : 'reader';
    const maxActiveAccounts = PLANS[effectivePlan].maxActiveAccounts;
    if (maxActiveAccounts !== null) {
      const activeAccounts = await sql<Array<{ provider: string; accountId: string }>>`
        select provider, account_id from public.organization_ad_accounts
        where organization_id = ${target} and enabled = true
        order by discovered_at asc, provider asc, account_id asc
        for update
      `;
      for (const account of activeAccounts.slice(maxActiveAccounts)) {
        await sql`
          update public.organization_ad_accounts set enabled = false
          where organization_id = ${target} and provider = ${account.provider} and account_id = ${account.accountId}
        `;
      }
    }

    await sql`
      insert into public.audit_events
        (organization_id, event, provider, tool, account_id, summary, details)
      values
        (${target}, 'subscription_updated', 'cloud', 'stripe_webhook', '*',
         ${`Subscription changed to ${effectivePlan} (${status})`},
         ${sql.json({ plan: effectivePlan, status, maxActiveAccounts } as never)})
    `;
  });
}

export async function processStripeEvent(event: Stripe.Event): Promise<'processed' | 'duplicate' | 'ignored'> {
  const existing = await db()<Array<{ eventId: string }>>`
    select event_id from private.billing_events where event_id = ${event.id} limit 1
  `;
  if (existing.length) return 'duplicate';

  let handled = false;
  if (event.type === 'customer.subscription.created'
    || event.type === 'customer.subscription.updated'
    || event.type === 'customer.subscription.deleted') {
    await applySubscription(event.data.object);
    handled = true;
  }
  await db()`
    insert into private.billing_events (event_id, event_type)
    values (${event.id}, ${event.type})
    on conflict (event_id) do nothing
  `;
  return handled ? 'processed' : 'ignored';
}

export function resetBillingForTests(): void {
  client = undefined;
}
