import 'server-only';
import Stripe from 'stripe';
import type postgres from 'postgres';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { PLANS, subscriptionHasAccess, subscriptionEnded, type BillingInterval, type PlanId, type SubscriptionStatus } from './plans';
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
  client ??= new Stripe(key, { timeout: 8_000, maxNetworkRetries: 1 });
  return client;
}

function stripePriceIdOrUndefined(plan: Extract<PlanId, 'operator' | 'premium' | 'agency'>, interval: BillingInterval): string | undefined {
  const value = env();
  if (plan === 'operator') return interval === 'annual' ? value.STRIPE_PRO_ANNUAL_PRICE_ID : value.STRIPE_PRO_PRICE_ID;
  if (plan === 'premium') return interval === 'annual' ? value.STRIPE_GROWTH_ANNUAL_PRICE_ID : value.STRIPE_GROWTH_PRICE_ID;
  return interval === 'annual' ? value.STRIPE_AGENCY_V2_ANNUAL_PRICE_ID : value.STRIPE_AGENCY_V2_PRICE_ID;
}

export function stripePriceId(plan: Extract<PlanId, 'operator' | 'premium' | 'agency'>, interval: BillingInterval): string {
  const priceId = stripePriceIdOrUndefined(plan, interval);
  if (!priceId) throw new Error(`${plan} ${interval} Stripe price is not configured.`);
  return priceId;
}

export function planForPrice(priceId: string | undefined): PlanId | undefined {
  if (!priceId) return undefined;
  const value = env();
  if (priceId === value.STRIPE_PRO_PRICE_ID || priceId === value.STRIPE_PRO_ANNUAL_PRICE_ID) return 'operator';
  if (priceId === value.STRIPE_GROWTH_PRICE_ID || priceId === value.STRIPE_GROWTH_ANNUAL_PRICE_ID) return 'premium';
  if (priceId === value.STRIPE_AGENCY_V2_PRICE_ID || priceId === value.STRIPE_AGENCY_V2_ANNUAL_PRICE_ID) return 'agency';
  if (priceId === value.STRIPE_OPERATOR_PRICE_ID || priceId === value.STRIPE_OPERATOR_ANNUAL_PRICE_ID) return 'operator';
  if (priceId === value.STRIPE_PREMIUM_PRICE_ID || priceId === value.STRIPE_PREMIUM_ANNUAL_PRICE_ID) return 'premium';
  if (priceId === value.STRIPE_AGENCY_PRICE_ID || priceId === value.STRIPE_AGENCY_ANNUAL_PRICE_ID) return 'agency';
  const legacy = value.STRIPE_LEGACY_PRICE_PLAN_MAP;
  if (legacy) {
    const mapping: unknown = JSON.parse(legacy);
    if (mapping && typeof mapping === 'object' && !Array.isArray(mapping) && Object.hasOwn(mapping, priceId)) {
      const plan = (mapping as Record<string, unknown>)[priceId];
      if (plan === 'operator' || plan === 'premium' || plan === 'agency') return plan;
    }
  }
  return undefined;
}

type BillingSql = postgres.Sql | postgres.TransactionSql;

export async function lockBillingOrganization(sql: BillingSql, organizationId: string): Promise<void> {
  const rows = await sql<Array<{ id: string }>>`
    select id from public.organization_groups where default_project_id = ${organizationId} for update
  `;
  if (!rows.length) throw new Error('Billing organization not found.');
}

/** Read under the organization lock. Event snapshots can arrive in any order. */
export async function currentStripeSubscription(customerId: string, organizationId: string, preferredId?: string | null): Promise<Stripe.Subscription | undefined> {
  const subscriptions = await stripeClient().subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  if (subscriptions.has_more) throw new Error('Too many subscriptions to reconcile safely.');
  const bound = subscriptions.data.filter(subscription => {
    if (subscription.id === preferredId && subscription.metadata.organizationId && subscription.metadata.organizationId !== organizationId) {
      throw new Error('Stripe subscription organization does not match its billing account.');
    }
    return subscription.metadata.organizationId === organizationId || subscription.id === preferredId;
  });
  if (!bound.length && subscriptions.data.length) throw new Error('Stripe customer has no subscription bound to this organization.');
  const rank = (subscription: Stripe.Subscription) => subscriptionHasAccess(subscription.status) ? 2 : subscriptionEnded(subscription.status) ? 0 : 1;
  bound.sort((a, b) => rank(b) - rank(a) || b.created - a.created || b.id.localeCompare(a.id));
  const highest = bound[0];
  if (!highest) return undefined;
  const preferred = bound.find(subscription => subscription.id === preferredId && rank(subscription) === rank(highest) && !subscriptionEnded(subscription.status));
  if (bound.filter(subscription => subscriptionHasAccess(subscription.status)).length > 1) {
    console.error('Multiple paid Stripe subscriptions for billing organization', organizationId);
  }
  return preferred ?? highest;
}

interface StoredSubscription {
  billingProvider: string | null;
  plan: PlanId;
  status: SubscriptionStatus;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: Date | null;
  canceledAt: Date | null;
  cancellationReason: string | null;
}

const date = (seconds: number | null | undefined) => seconds ? new Date(seconds * 1000) : null;
const time = (value: Date | null | undefined) => value?.getTime() ?? null;

async function syncLockedSubscription(sql: BillingSql, organizationId: string, customerId: string, eventId?: string) {
  const [previous] = await sql<StoredSubscription[]>`
    select billing_provider, plan, status, provider_customer_id, provider_subscription_id, current_period_end,
      cancel_at_period_end, cancel_at, canceled_at, cancellation_reason
    from public.organization_subscriptions where organization_id = ${organizationId} for update
  `;
  if (!previous) throw new Error('Billing subscription record not found.');
  const manualGrant = previous.billingProvider !== 'stripe' && !previous.providerSubscriptionId
    && previous.plan !== 'reader' && subscriptionHasAccess(previous.status);
  // Administrators can detach a canceled Stripe customer to grant beta access.
  // A new checkout reserves its customer explicitly before Stripe can notify us.
  if (manualGrant && !previous.providerCustomerId) return { updated: false };
  if (previous.providerCustomerId && previous.providerCustomerId !== customerId) throw new Error('Stripe customer does not match this organization.');
  const subscription = await currentStripeSubscription(customerId, organizationId, previous.providerSubscriptionId);
  if (!subscription) throw new Error('Stripe subscription not found; access was left unchanged.');
  // A pending or failed payment must not remove an existing manual grant.
  if (manualGrant && !subscriptionHasAccess(subscription.status)) return { updated: false };
  const item = subscription.items.data[0];
  const mappedPlan = planForPrice(item?.price.id);
  if (!mappedPlan && !subscriptionEnded(subscription.status)) throw new Error('Stripe subscription price is not mapped to an Adport plan.');
  const plan = mappedPlan ?? previous.plan;
  if (!['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'canceled', 'paused', 'incomplete_expired'].includes(subscription.status)) throw new Error('Unrecognized Stripe subscription status.');
  const status = subscription.status as SubscriptionStatus;
  const currentPeriodEnd = date(item?.current_period_end);
  const cancelAt = date(subscription.cancel_at);
  const canceledAt = date(subscription.ended_at);
  const cancellationReason = subscription.cancellation_details?.reason ?? null;
  const changed = previous.plan !== plan || previous.status !== status
    || previous.providerCustomerId !== customerId || previous.providerSubscriptionId !== subscription.id
    || time(previous.currentPeriodEnd) !== time(currentPeriodEnd) || previous.cancelAtPeriodEnd !== subscription.cancel_at_period_end
    || time(previous.cancelAt) !== time(cancelAt) || time(previous.canceledAt) !== time(canceledAt)
    || previous.cancellationReason !== cancellationReason;
  await sql`
    update public.organization_subscriptions set plan = ${plan}, status = ${status}, billing_provider = 'stripe',
      provider_customer_id = ${customerId}, provider_subscription_id = ${subscription.id}, current_period_end = ${currentPeriodEnd},
      cancel_at_period_end = ${subscription.cancel_at_period_end}, cancel_at = ${cancelAt}, canceled_at = ${canceledAt},
      cancellation_reason = ${cancellationReason}, last_synced_at = now()
    where organization_id = ${organizationId}
  `;
  if (!changed) return { updated: false };

  const effectivePlan = subscriptionHasAccess(status) ? plan : 'reader';
  const maxActiveAccounts = await applyOrganizationPlanLimits(sql, organizationId, effectivePlan);
  await sql`
    insert into public.audit_events (organization_id, event, provider, tool, account_id, summary, details)
    values (${organizationId}, 'subscription_updated', 'cloud', ${eventId ? 'stripe_webhook' : 'stripe_reconcile'}, '*',
      ${`Subscription changed to ${effectivePlan} (${status})`}, ${sql.json({ plan: effectivePlan, status, maxActiveAccounts, cancellationReason } as never)})
  `;
  return { updated: true, analytics: previous.status !== status && subscription.metadata.analyticsActorUserId
    ? { userId: subscription.metadata.analyticsActorUserId, status, plan } : undefined };
}

export async function applyOrganizationPlanLimits(sql: BillingSql, organizationId: string, effectivePlan: PlanId): Promise<number | null> {
  await sql`update public.organization_settings setting
    set data_retention_days = least(setting.data_retention_days, ${PLANS[effectivePlan].maxRetentionDays})
    from public.organizations project join public.organization_groups company on company.id = project.organization_group_id
    where setting.organization_id = project.id and company.default_project_id = ${organizationId}`;
  const maxActiveAccounts = PLANS[effectivePlan].maxActiveAccounts;
  if (maxActiveAccounts !== null) {
    const accounts = await sql<Array<{ organizationId: string; provider: string; accountId: string }>>`
      select account.organization_id, account.provider, account.account_id from public.organization_ad_accounts account
      join public.organizations project on project.id = account.organization_id
      join public.organization_groups company on company.id = project.organization_group_id
      where company.default_project_id = ${organizationId} and project.archived_at is null and account.enabled = true
        and private.provider_uses_ad_account_slot(account.provider)
      order by account.discovered_at, account.provider, account.account_id, account.organization_id for update of account
    `;
    for (const account of accounts.slice(maxActiveAccounts)) await sql`
      update public.organization_ad_accounts set enabled = false
      where organization_id = ${account.organizationId} and provider = ${account.provider} and account_id = ${account.accountId}
    `;
  }
  return maxActiveAccounts;
}

export async function reconcileOrganizationSubscription(organizationId: string, customerId: string): Promise<boolean> {
  return db().begin(async sql => {
    await lockBillingOrganization(sql, organizationId);
    return (await syncLockedSubscription(sql, organizationId, customerId)).updated;
  });
}

export async function processStripeEvent(event: Stripe.Event): Promise<'processed' | 'duplicate' | 'ignored'> {
  const outcome = await db().begin(async sql => {
    // The primary-key claim and all effects commit together. A failed sync can be retried.
    const claimed = await sql<Array<{ eventId: string }>>`
      insert into private.billing_events (event_id, event_type) values (${event.id}, ${event.type})
      on conflict (event_id) do nothing returning event_id
    `;
    if (!claimed.length) return { result: 'duplicate' as const };
    if (!['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
      'customer.subscription.paused', 'customer.subscription.resumed'].includes(event.type)) return { result: 'ignored' as const };
    const snapshot = event.data.object as Stripe.Subscription;
    const customerId = typeof snapshot.customer === 'string' ? snapshot.customer : snapshot.customer.id;
    const targets = snapshot.metadata.organizationId ? [{ organizationId: snapshot.metadata.organizationId }]
      : await sql<Array<{ organizationId: string }>>`
        select organization_id from public.organization_subscriptions
        where provider_subscription_id = ${snapshot.id} or provider_customer_id = ${customerId} limit 1
      `;
    const organizationId = targets[0]?.organizationId;
    if (!organizationId) throw new Error('Stripe subscription is not bound to an Adport organization.');
    await lockBillingOrganization(sql, organizationId);
    const synced = await syncLockedSubscription(sql, organizationId, customerId, event.id);
    return { result: 'processed' as const, organizationId, analytics: synced.analytics };
  });
  if ('analytics' in outcome && outcome.analytics) captureProductEvent({ organizationId: outcome.organizationId, userId: outcome.analytics.userId }, {
    event: 'subscription_status_changed', subscription_status: outcome.analytics.status, target_plan: outcome.analytics.plan,
  }, event.id);
  return outcome.result;
}

export async function reconcileBillingSubscriptions() {
  const organizations = await db()<Array<{ organizationId: string; providerCustomerId: string }>>`
    select subscription.organization_id, subscription.provider_customer_id from public.organization_subscriptions subscription
    join public.organization_groups company on company.default_project_id = subscription.organization_id
    where subscription.billing_provider = 'stripe' and subscription.provider_customer_id is not null
    order by subscription.last_reconciliation_attempt_at nulls first, subscription.organization_id limit 50
  `;
  let updated = 0;
  let failed = 0;
  let checked = 0;
  const deadline = Date.now() + 30_000;
  for (const organization of organizations) {
    if (Date.now() >= deadline) break;
    checked++;
    try { if (await reconcileOrganizationSubscription(organization.organizationId, organization.providerCustomerId)) updated++; }
    catch (error) {
      failed++;
      console.error('Stripe reconciliation failed for organization', organization.organizationId, error instanceof Error ? error.message : 'unknown error');
    } finally {
      // A permanently invalid customer must not starve the rest of the batch.
      await db()`update public.organization_subscriptions set last_reconciliation_attempt_at = now() where organization_id = ${organization.organizationId}`;
    }
  }
  return { checked, updated, failed };
}

export function resetBillingForTests(): void {
  client = undefined;
}
