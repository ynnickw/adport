'use server';

import { redirect } from 'next/navigation';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { stripeClient, stripePriceId } from '@/lib/cloud/billing';
import { getOrganizationEntitlement, type BillingInterval, type PlanId } from '@/lib/cloud/plans';
import { env } from '@/lib/env';

function requireOwner(role: string | undefined): void {
  if (role !== 'owner') throw new Error('Only the workspace owner can manage billing.');
}

export async function startSubscription(plan: PlanId, interval: BillingInterval): Promise<void> {
  if (plan !== 'operator' && plan !== 'agency') throw new Error('Choose Operator or Agency.');
  if (interval !== 'monthly' && interval !== 'annual') throw new Error('Choose monthly or annual billing.');
  const principal = await sessionPrincipal();
  requireOwner(principal.role);
  const entitlement = await getOrganizationEntitlement(principal.organizationId);
  if (entitlement.providerSubscriptionId) throw new Error('Manage the existing subscription in the billing portal.');
  const baseUrl = env().ADPORT_CLOUD_BASE_URL;
  const session = await stripeClient().checkout.sessions.create({
    mode: 'subscription',
    customer: entitlement.providerCustomerId ?? undefined,
    client_reference_id: principal.organizationId,
    line_items: [{ price: stripePriceId(plan, interval), quantity: 1 }],
    billing_address_collection: 'required',
    allow_promotion_codes: true,
    metadata: { organizationId: principal.organizationId, plan, interval },
    subscription_data: { metadata: { organizationId: principal.organizationId, plan, interval } },
    success_url: new URL('/dashboard/billing?checkout=complete', baseUrl).toString(),
    cancel_url: new URL('/dashboard/billing?checkout=canceled', baseUrl).toString(),
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL.');
  redirect(session.url);
}

export async function openBillingPortal(): Promise<void> {
  const principal = await sessionPrincipal();
  requireOwner(principal.role);
  const entitlement = await getOrganizationEntitlement(principal.organizationId);
  if (!entitlement.providerCustomerId) throw new Error('No billing customer exists for this workspace.');
  const portal = await stripeClient().billingPortal.sessions.create({
    customer: entitlement.providerCustomerId,
    return_url: new URL('/dashboard/billing', env().ADPORT_CLOUD_BASE_URL).toString(),
  });
  redirect(portal.url);
}
