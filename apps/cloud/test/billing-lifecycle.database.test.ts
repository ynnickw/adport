import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stripe = vi.hoisted(() => ({ list: vi.fn(), listSessions: vi.fn(), retrieveSubscription: vi.fn(), create: vi.fn(), retrieve: vi.fn(), expire: vi.fn(), customer: vi.fn(), capture: vi.fn() }));
vi.mock('stripe', () => ({ default: class {
  subscriptions = { list: stripe.list, retrieve: stripe.retrieveSubscription };
  customers = { create: stripe.customer };
  checkout = { sessions: { create: stripe.create, retrieve: stripe.retrieve, expire: stripe.expire, list: stripe.listSessions } };
} }));
vi.mock('@/lib/cloud/product-analytics', () => ({ captureProductEvent: stripe.capture }));

import { db, closeDbForTests } from '@/lib/db';
import { processStripeEvent, reconcileBillingSubscriptions, reconcileOrganizationSubscription, resetBillingForTests } from '@/lib/cloud/billing';
import { subscriptionCheckoutUrl } from '@/lib/cloud/billing-checkout';
import { getOrganizationEntitlement, applyPlanToPrincipal } from '@/lib/cloud/plans';
import { resolveMembership, upsertGoogleConnection } from '@/lib/cloud/repository';
import { resetEnvForTests } from '@/lib/env';

const describeDatabase = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;
describeDatabase('Stripe lifecycle with real Postgres transactions', () => {
  const run = randomUUID();
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  let owner: string;
  let organization: string;
  let current: Stripe.Subscription[];
  let sessions: Map<string, Stripe.Checkout.Session>;
  let keys: Map<string, string>;
  const customer = `cus_billing_${run}`;
  const subscriptionId = `sub_billing_${run}`;
  const periodEnd = 1_800_000_000;
  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    id: subscriptionId, customer, created: 100, status: 'active', metadata: { organizationId: organization, analyticsActorUserId: owner },
    items: { data: [{ price: { id: 'price_agency_billing_fixture' }, current_period_end: periodEnd }] },
    cancel_at_period_end: false, cancel_at: null, ended_at: null, cancellation_details: { reason: null }, ...overrides,
  }) as unknown as Stripe.Subscription;
  const event = (label: string, object = snapshot(), type = 'customer.subscription.updated') => ({
    id: `evt_billing_${run}_${label}`, type, created: label.includes('old') ? 1 : 200, data: { object },
  }) as unknown as Stripe.Event;
  const audits = () => db()<Array<{ count: number }>>`select count(*)::int as count from public.audit_events where organization_id = ${organization} and event = 'subscription_updated'`;

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1'].includes(new URL(process.env.SUPABASE_DB_URL!).hostname)) throw new Error('Billing fixture tests require a local database.');
    process.env.STRIPE_AGENCY_V2_PRICE_ID = 'price_agency_billing_fixture';
    process.env.STRIPE_PRO_PRICE_ID = 'price_pro_billing_fixture';
    resetEnvForTests(); resetBillingForTests();
    const created = await admin.auth.admin.createUser({ email: `billing-${run}@example.test`, password: 'Local-billing-fixture-123!', email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error('Local fixture user missing');
    owner = created.data.user.id;
    organization = (await resolveMembership(owner)).organizationId;
    await db()`update public.organization_subscriptions set plan = 'agency' where organization_id = ${organization}`;
    await upsertGoogleConnection({ organizationId: organization, userId: owner, refreshToken: 'local-billing-fixture-only', accessibleCustomerIds: [] });
    const [connection] = await db()<Array<{ id: string }>>`select id from public.connections where organization_id = ${organization} and provider = 'google'`;
    for (let i = 0; i < 7; i++) await db()`insert into public.organization_ad_accounts (organization_id, connection_id, provider, account_id, name)
      values (${organization}, ${connection!.id}, 'google', ${`billing-${i}`}, ${`Billing fixture ${i}`})`;
  });
  afterAll(async () => {
    if (organization) {
      await db()`delete from private.billing_events where event_id like ${`evt_billing_${run}_%`}`;
      await db()`delete from public.organizations where id = ${organization}`;
    }
    if (owner) await admin.auth.admin.deleteUser(owner);
    delete process.env.STRIPE_AGENCY_V2_PRICE_ID; delete process.env.STRIPE_PRO_PRICE_ID; resetEnvForTests(); resetBillingForTests();
    await closeDbForTests();
  });
  beforeEach(async () => {
    vi.clearAllMocks(); current = [snapshot()]; sessions = new Map(); keys = new Map();
    stripe.list.mockImplementation(async () => ({ data: structuredClone(current), has_more: false }));
    stripe.listSessions.mockImplementation(() => ({ async *[Symbol.asyncIterator]() { yield* structuredClone([...sessions.values()].filter(session => session.status === 'open')); } }));
    stripe.retrieveSubscription.mockImplementation(async id => structuredClone(current.find(subscription => subscription.id === id)));
    stripe.customer.mockResolvedValue({ id: customer });
    stripe.create.mockImplementation(async (parameters, options) => {
      const existing = keys.get(options.idempotencyKey);
      if (existing) return structuredClone(sessions.get(existing));
      const id = `cs_fixture_${sessions.size}`;
      const session = { id, status: 'open', url: `https://checkout.stripe.com/offline/${id}`, metadata: parameters.metadata } as Stripe.Checkout.Session;
      keys.set(options.idempotencyKey, id); sessions.set(id, session); return structuredClone(session);
    });
    stripe.retrieve.mockImplementation(async id => structuredClone(sessions.get(id)));
    stripe.expire.mockImplementation(async id => {
      const session = sessions.get(id)!;
      if (session.status !== 'open') throw new Error('Session payment already completed');
      session.status = 'expired'; return structuredClone(session);
    });
    await db()`update public.organization_subscriptions set plan = 'agency', status = 'active', billing_provider = 'stripe',
      provider_customer_id = ${customer}, provider_subscription_id = ${subscriptionId}, current_period_end = ${new Date(periodEnd * 1000)},
      cancel_at_period_end = false, cancel_at = null, canceled_at = null, cancellation_reason = null, last_synced_at = null where organization_id = ${organization}`;
    await db()`update public.organization_ad_accounts set enabled = true where organization_id = ${organization}`;
    await db()`update public.organization_settings set data_retention_days = 365 where organization_id = ${organization}`;
    await db()`delete from public.audit_events where organization_id = ${organization} and event = 'subscription_updated'`;
    await db()`delete from private.billing_checkout_attempts where organization_id = ${organization}`;
  });

  it('preserves paid access until a scheduled cancellation actually ends', async () => {
    current = [snapshot({ cancel_at_period_end: true, cancel_at: periodEnd })];
    await processStripeEvent(event('scheduled'));
    expect(await getOrganizationEntitlement(organization)).toMatchObject({ plan: { id: 'agency' }, cancelAtPeriodEnd: true, cancelAt: new Date(periodEnd * 1000) });
    current = [snapshot({ status: 'canceled', ended_at: 200, cancellation_details: { reason: 'cancellation_requested' } })];
    await processStripeEvent(event('ended', snapshot(), 'customer.subscription.deleted'));
    const entitlement = await getOrganizationEntitlement(organization);
    expect(entitlement.plan.id).toBe('reader');
    expect((await applyPlanToPrincipal({ organizationId: organization, role: 'owner', scopes: ['tools:read', 'tools:write'] })).scopes).toEqual(['tools:read']);
    const [accounts] = await db()<Array<{ count: number }>>`select count(*)::int as count from public.organization_ad_accounts where organization_id = ${organization} and enabled`;
    expect(accounts?.count).toBe(3);
    const [settings] = await db()<Array<{ dataRetentionDays: number }>>`select data_retention_days from public.organization_settings where organization_id = ${organization}`;
    expect(settings?.dataRetentionDays).toBe(30);
  });
  it('uses current Stripe state when an old active snapshot follows cancellation', async () => {
    current = [snapshot({ status: 'canceled', ended_at: 200 })];
    await processStripeEvent(event('deleted', current[0], 'customer.subscription.deleted'));
    await processStripeEvent(event('old_active', snapshot()));
    expect((await getOrganizationEntitlement(organization)).plan.id).toBe('reader');
    expect((await audits())[0]?.count).toBe(1);
  });
  it('ignores the previous subscription snapshot after a customer subscribes again', async () => {
    current = [snapshot({ status: 'canceled' }), snapshot({ id: 'sub_new', status: 'active', created: 300 })];
    await processStripeEvent(event('new', current[1], 'customer.subscription.created'));
    await processStripeEvent(event('old_deleted', current[0], 'customer.subscription.deleted'));
    expect(await getOrganizationEntitlement(organization)).toMatchObject({ providerSubscriptionId: 'sub_new', plan: { id: 'agency' } });
  });
  it('deduplicates concurrent deliveries within the same transaction as all side effects', async () => {
    current = [snapshot({ status: 'canceled' })];
    const results = await Promise.all([processStripeEvent(event('duplicate')), processStripeEvent(event('duplicate'))]);
    expect(results.sort()).toEqual(['duplicate', 'processed']); expect(stripe.list).toHaveBeenCalledTimes(1);
    expect((await audits())[0]?.count).toBe(1);
  });
  it('rolls back the event claim when Stripe is unavailable, allowing an intact retry', async () => {
    current = [snapshot({ status: 'canceled' })]; stripe.list.mockRejectedValueOnce(new Error('Stripe timeout'));
    await expect(processStripeEvent(event('retry'))).rejects.toThrow('Stripe timeout');
    expect((await getOrganizationEntitlement(organization)).plan.id).toBe('agency');
    expect(await processStripeEvent(event('retry'))).toBe('processed'); expect((await audits())[0]?.count).toBe(1);
  });
  it.each(['unpaid', 'incomplete', 'incomplete_expired', 'paused'])('removes writes for %s without losing the provider state', async status => {
    current = [snapshot({ status })]; await processStripeEvent(event(status));
    expect(await getOrganizationEntitlement(organization)).toMatchObject({ status, plan: { id: 'reader' } });
  });
  it('keeps a past-due grace period and restores a paused subscription on resume', async () => {
    current = [snapshot({ status: 'past_due' })]; await processStripeEvent(event('past_due'));
    expect((await getOrganizationEntitlement(organization)).plan.id).toBe('agency');
    current = [snapshot({ status: 'paused' })]; await processStripeEvent(event('paused', current[0], 'customer.subscription.paused'));
    current = [snapshot()]; await processStripeEvent(event('resumed', current[0], 'customer.subscription.resumed'));
    expect((await getOrganizationEntitlement(organization)).plan.id).toBe('agency');
  });
  it('recovers a missed cancellation through reconciliation without replaying old snapshots', async () => {
    current = [snapshot({ status: 'canceled', ended_at: 200, cancellation_details: { reason: 'payment_failed' } })];
    expect(await reconcileOrganizationSubscription(organization, customer)).toBe(true);
    expect(await getOrganizationEntitlement(organization)).toMatchObject({ cancellationReason: 'payment_failed', plan: { id: 'reader' } });
    expect(await reconcileOrganizationSubscription(organization, customer)).toBe(false);
    expect((await audits())[0]?.count).toBe(1);
  });
  it('retains access and rolls back an event if its customer binding is wrong', async () => {
    await expect(processStripeEvent(event('wrong_customer', snapshot({ customer: 'cus_other' })))).rejects.toThrow('customer does not match');
    expect((await getOrganizationEntitlement(organization)).plan.id).toBe('agency');
  });
  it('preserves a detached manual grant when an unseen old Stripe cancellation arrives', async () => {
    await db()`update public.organization_subscriptions set billing_provider = null, provider_customer_id = null,
      provider_subscription_id = null where organization_id = ${organization}`;
    current = [snapshot({ status: 'canceled' })];
    await processStripeEvent(event('detached_manual', current[0], 'customer.subscription.deleted'));
    expect(await getOrganizationEntitlement(organization)).toMatchObject({ plan: { id: 'agency' }, status: 'active', providerCustomerId: null, providerSubscriptionId: null });
    expect(stripe.list).not.toHaveBeenCalled(); expect((await audits())[0]?.count).toBe(0);
  });
  it('keeps manual access during incomplete checkout, then activates the explicitly chosen subscription', async () => {
    current = [];
    await db()`update public.organization_subscriptions set billing_provider = null, provider_customer_id = null,
      provider_subscription_id = null where organization_id = ${organization}`;
    await subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly');
    current = [snapshot({ status: 'incomplete' })]; await processStripeEvent(event('manual_pending', current[0], 'customer.subscription.created'));
    expect((await getOrganizationEntitlement(organization)).plan.id).toBe('agency');
    current = [snapshot({ status: 'trialing', items: { data: [{ price: { id: 'price_pro_billing_fixture' }, current_period_end: periodEnd }] } })];
    await processStripeEvent(event('manual_confirmed', current[0]));
    expect(await getOrganizationEntitlement(organization)).toMatchObject({ plan: { id: 'operator' }, status: 'trialing', providerSubscriptionId: subscriptionId });
  });

  async function freeCustomer() {
    current = [];
    await db()`update public.organization_subscriptions set plan = 'reader', status = 'active', billing_provider = null,
      provider_customer_id = null, provider_subscription_id = null where organization_id = ${organization}`;
  }
  it.each(['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused'])('blocks a new Checkout for an existing %s subscription', async status => {
    await db()`update public.organization_subscriptions set status = ${status} where organization_id = ${organization}`;
    await expect(subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly')).rejects.toThrow('billing portal');
    expect(stripe.create).not.toHaveBeenCalled();
  });
  it('expires a legacy unpaid session without affecting another organization', async () => {
    await freeCustomer();
    sessions.set('cs_legacy', { id: 'cs_legacy', status: 'open', client_reference_id: organization } as Stripe.Checkout.Session);
    sessions.set('cs_other', { id: 'cs_other', status: 'open', client_reference_id: 'other-organization' } as Stripe.Checkout.Session);
    await subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly');
    expect(sessions.get('cs_legacy')?.status).toBe('expired');
    expect(sessions.get('cs_other')?.status).toBe('open');
  });
  it('reuses one customer and one payable Checkout session for simultaneous requests', async () => {
    await freeCustomer();
    const urls = await Promise.all([subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly'), subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly')]);
    expect(urls[0]).toBe(urls[1]); expect(stripe.customer).toHaveBeenCalledTimes(1); expect(stripe.create).toHaveBeenCalledTimes(1);
    expect(stripe.create.mock.calls[0]![0]).toMatchObject({ subscription_data: { trial_period_days: 7, metadata: { analyticsActorUserId: owner } } });
  });
  it('survives a lost Stripe response using the persisted attempt and exact idempotency key', async () => {
    await freeCustomer();
    const create = stripe.create.getMockImplementation()!;
    stripe.create.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('Response lost after Stripe committed'); });
    await expect(subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly')).rejects.toThrow('Response lost');
    await subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly');
    expect(sessions.size).toBe(1); expect(stripe.create.mock.calls[0]).toEqual(stripe.create.mock.calls[1]);
  });
  it('replaces an expired attempt safely after the Stripe idempotency retention window', async () => {
    await freeCustomer();
    const create = stripe.create.getMockImplementation()!;
    stripe.create.mockImplementationOnce(async (...args) => { await create(...args); throw new Error('Lost response'); });
    await expect(subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly')).rejects.toThrow('Lost response');
    await db()`update private.billing_checkout_attempts set parameters = jsonb_set(parameters, '{expires_at}', to_jsonb(extract(epoch from now())::bigint - 1)) where organization_id = ${organization}`;
    await subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly');
    expect([...sessions.values()].filter(session => session.status === 'open')).toHaveLength(1);
    expect(stripe.create.mock.calls[0]![1].idempotencyKey).not.toBe(stripe.create.mock.calls[1]![1].idempotencyKey);
  });
  it('allows renewal when Stripe has ended the subscription before the cancellation webhook arrives', async () => {
    current = [snapshot({ status: 'canceled' })];
    await subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly');
    expect(stripe.create.mock.calls[0]![0].subscription_data).not.toHaveProperty('trial_period_days');
  });
  it('expires the previous unpaid session before opening a different plan', async () => {
    await freeCustomer(); await subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly');
    await subscriptionCheckoutUrl(organization, owner, 'agency', 'monthly');
    expect(stripe.expire).toHaveBeenCalledTimes(1);
    expect([...sessions.values()].filter(session => session.status === 'open')).toHaveLength(1);
  });
  it('blocks a second checkout when payment finished before its subscription webhook arrived', async () => {
    await freeCustomer(); await subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly');
    current = [snapshot()];
    await expect(subscriptionCheckoutUrl(organization, owner, 'agency', 'monthly')).rejects.toThrow('already exists');
    expect(stripe.create).toHaveBeenCalledTimes(1);
  });
  it('does not open a replacement if the old session finishes payment while being expired', async () => {
    await freeCustomer(); await subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly');
    stripe.expire.mockRejectedValueOnce(new Error('Payment completed meanwhile'));
    await expect(subscriptionCheckoutUrl(organization, owner, 'agency', 'monthly')).rejects.toThrow('Payment completed');
    expect(stripe.create).toHaveBeenCalledTimes(1);
  });
  it('allows resubscription after the old completed Checkout subscription was canceled, without another trial', async () => {
    await freeCustomer(); await subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly');
    const session = [...sessions.values()][0]!; session.status = 'complete'; session.subscription = subscriptionId;
    current = [snapshot({ status: 'canceled' })]; await processStripeEvent(event('checkout_canceled'));
    await subscriptionCheckoutUrl(organization, owner, 'operator', 'monthly');
    expect(stripe.create.mock.calls.at(-1)![0].subscription_data).not.toHaveProperty('trial_period_days');
  });
  it('does not expose persisted Checkout parameters to authenticated or anonymous clients', async () => {
    const [access] = await db()<Array<{ authenticated: boolean; anonymous: boolean }>>`select
      has_table_privilege('authenticated', 'private.billing_checkout_attempts', 'SELECT') as authenticated,
      has_table_privilege('anon', 'private.billing_checkout_attempts', 'SELECT') as anonymous`;
    expect(access).toEqual({ authenticated: false, anonymous: false });
  });
});
