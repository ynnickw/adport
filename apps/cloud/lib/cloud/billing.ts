import 'server-only';
import Stripe from 'stripe';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { PLANS, type BillingInterval, type PlanId, type SubscriptionStatus } from './plans';
import { captureProductEvent } from './product-analytics';

let client: Stripe | undefined;

export function billingConfigured(): boolean {
  const value = env();
  return Boolean(value.STRIPE_SECRET_KEY && value.STRIPE_WEBHOOK_SECRET);
}

export function billingPlanConfigured(plan: Extract<PlanId, 'operator' | 'premium' | 'agency'>, interval: BillingInterval): boolean {
  if (!billingConfigured()) return false;
  return Boolean(stripePriceIdOrUndefined(plan, interval));
}

export function stripeClient(): Stripe {
  const key = env().STRIPE_SECRET_KEY;
  if (!key) throw new Error('Stripe billing is not configured.');
  client ??= new Stripe(key);
  return client;
}

function stripePriceIdOrUndefined(plan: Extract<PlanId, 'operator' | 'premium' | 'agency'>, interval: BillingInterval): string | undefined {
  const value = env();
  if (plan === 'operator') return interval === 'annual' ? value.STRIPE_OPERATOR_ANNUAL_PRICE_ID : value.STRIPE_OPERATOR_PRICE_ID;
  if (plan === 'premium') return interval === 'annual' ? value.STRIPE_PREMIUM_ANNUAL_PRICE_ID : value.STRIPE_PREMIUM_PRICE_ID;
  return interval === 'annual' ? value.STRIPE_AGENCY_ANNUAL_PRICE_ID : value.STRIPE_AGENCY_PRICE_ID;
}

export function stripePriceId(plan: Extract<PlanId, 'operator' | 'premium' | 'agency'>, interval: BillingInterval): string {
  const priceId = stripePriceIdOrUndefined(plan, interval);
  if (!priceId) throw new Error(`${plan} ${interval} Stripe price is not configured.`);
  return priceId;
}

function planForPrice(priceId: string | undefined): PlanId | undefined {
  if (!priceId) return undefined;
  const value = env();
  if (priceId === value.STRIPE_OPERATOR_PRICE_ID || priceId === value.STRIPE_OPERATOR_ANNUAL_PRICE_ID) return 'operator';
  if (priceId === value.STRIPE_PREMIUM_PRICE_ID || priceId === value.STRIPE_PREMIUM_ANNUAL_PRICE_ID) return 'premium';
  if (priceId === value.STRIPE_AGENCY_PRICE_ID || priceId === value.STRIPE_AGENCY_ANNUAL_PRICE_ID) return 'agency';
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

async function applySubscription(subscription: Stripe.Subscription, eventId: string): Promise<void> {
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
  const changed = await db().begin(async (sql) => {
    await sql`select company.id from public.organization_groups company where company.default_project_id = ${target} for update`;
    const previous = await sql<Array<{ status: string }>>`select status from public.organization_subscriptions where organization_id = ${target} for update`;
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
    await sql`update public.organization_settings setting
      set data_retention_days = least(setting.data_retention_days, ${PLANS[effectivePlan].maxRetentionDays})
      from public.organizations project join public.organization_groups company on company.id = project.organization_group_id
      where setting.organization_id = project.id and company.default_project_id = ${target}`;
    const maxActiveAccounts = PLANS[effectivePlan].maxActiveAccounts;
    if (maxActiveAccounts !== null) {
      const activeAccounts = await sql<Array<{ organizationId: string; provider: string; accountId: string }>>`
        select account.organization_id, account.provider, account.account_id from public.organization_ad_accounts account
        join public.organizations project on project.id = account.organization_id
        join public.organization_groups company on company.id = project.organization_group_id
        where company.default_project_id = ${target} and account.enabled = true
        order by account.discovered_at, account.provider, account.account_id, account.organization_id
        for update of account
      `;
      for (const account of activeAccounts.slice(maxActiveAccounts)) {
        await sql`
          update public.organization_ad_accounts set enabled = false
          where organization_id = ${account.organizationId} and provider = ${account.provider} and account_id = ${account.accountId}
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
    return previous[0]?.status !== status;
  });
  const userId = subscription.metadata.analyticsActorUserId;
  if (changed && userId) captureProductEvent({ organizationId: target, userId }, {
    event: 'subscription_status_changed', subscription_status: status, target_plan: appliedPlan,
  }, eventId);
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
    await applySubscription(event.data.object, event.id);
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
