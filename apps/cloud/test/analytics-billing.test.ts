import { beforeEach, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';

const mocks = vi.hoisted(() => ({ capture: vi.fn(), sql: vi.fn(), begin: vi.fn(), list: vi.fn() }));
vi.mock('@/lib/cloud/product-analytics', () => ({ captureProductEvent: mocks.capture }));
vi.mock('@/lib/env', () => ({ env: () => ({ STRIPE_OPERATOR_PRICE_ID: 'price_operator_test', STRIPE_SECRET_KEY: 'sk_test_fixture' }) }));
vi.mock('@/lib/db', () => ({ db: () => Object.assign(mocks.sql, { begin: mocks.begin, json: (value: unknown) => value }) }));
vi.mock('stripe', () => ({ default: class { subscriptions = { list: mocks.list }; } }));
import { processStripeEvent } from '@/lib/cloud/billing';

let status: string;
let committed: boolean;
let seen: Set<string>;
beforeEach(() => {
  vi.clearAllMocks(); status = 'active'; committed = false; seen = new Set();
  mocks.sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    if (query.includes('insert into private.billing_events')) { const id = String(values[0]); if (seen.has(id)) return []; seen.add(id); return [{ eventId: id }]; }
    if (query.includes('select id from public.organization_groups')) return [{ id: 'company' }];
    if (query.includes('select billing_provider, plan, status')) return [{ billingProvider: 'stripe', plan: 'operator', status, providerCustomerId: 'cus_test', providerSubscriptionId: 'sub_test' }];
    if (query.includes('select status')) return [{ status }];
    if (query.includes('update public.organization_subscriptions')) status = String(values[1]);
    return [];
  });
  mocks.begin.mockImplementation(async callback => { const result = await callback(Object.assign(mocks.sql, { json: (value: unknown) => value })); committed = true; return result; });
  mocks.capture.mockImplementation(() => { expect(committed).toBe(true); });
});

const event = (id: string, state: string, actor: string | undefined = 'checkout-initiator') => { const result = ({
  id, type: 'customer.subscription.updated', data: { object: { id: 'sub_test', customer: 'cus_test', status: state,
    metadata: { organizationId: 'billing-project', analyticsActorUserId: actor },
    items: { data: [{ price: { id: 'price_operator_test' } }] }, cancel_at_period_end: false,
  } },
}) as unknown as Stripe.Event; mocks.list.mockResolvedValue({ data: [result.data.object], has_more: false }); return result; };

it('tracks committed trial and active transitions for the checkout initiator, with Stripe deduplication', async () => {
  await expect(processStripeEvent(event('evt_trial', 'trialing'))).resolves.toBe('processed');
  expect(mocks.capture).toHaveBeenLastCalledWith({ organizationId: 'billing-project', userId: 'checkout-initiator' }, { event: 'subscription_status_changed', subscription_status: 'trialing', target_plan: 'operator' }, 'evt_trial');
  await expect(processStripeEvent(event('evt_trial', 'trialing'))).resolves.toBe('duplicate');
  expect(mocks.capture).toHaveBeenCalledTimes(1);
  await processStripeEvent(event('evt_active', 'active'));
  expect(mocks.capture).toHaveBeenLastCalledWith(expect.anything(), { event: 'subscription_status_changed', subscription_status: 'active', target_plan: 'operator' }, 'evt_active');
});

it('does not turn status refreshes or old subscriptions without actor metadata into conversions', async () => {
  await processStripeEvent(event('evt_refresh', 'active'));
  expect(mocks.capture).not.toHaveBeenCalled();
  await processStripeEvent(event('evt_legacy', 'trialing', ''));
  expect(mocks.capture).not.toHaveBeenCalled();
});
