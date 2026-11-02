'use server';

import { captureProductEvent } from '@/lib/cloud/product-analytics';
import { redirect } from 'next/navigation';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { stripeClient } from '@/lib/cloud/billing';
import { subscriptionCheckoutUrl } from '@/lib/cloud/billing-checkout';
import { getOrganizationEntitlement, type BillingInterval, type PlanId } from '@/lib/cloud/plans';
import { env } from '@/lib/env';
import { requireOrganizationAdmin } from '@/lib/cloud/workspaces';

function requireOwner(role: string | undefined): void {
  if (role !== 'owner') throw new Error('Only the workspace owner can manage billing.');
}

export interface BillingActionState { error?: string; }

async function checkoutUrl(plan: PlanId, interval: BillingInterval, projectId?: string): Promise<string> {
  if (plan !== 'operator' && plan !== 'premium' && plan !== 'agency') throw new Error('Choose Pro, Growth, or Business.');
  if (interval !== 'monthly' && interval !== 'annual') throw new Error('Choose monthly or annual billing.');
  const principal = await sessionPrincipal(projectId);
  requireOwner(principal.role);
  const entitlement = await getOrganizationEntitlement(principal.organizationId);
  const billingOrganizationId = entitlement.billingOrganizationId ?? principal.organizationId;
  const organization = await requireOrganizationAdmin(principal.userId!, billingOrganizationId);
  requireOwner(organization.role);
  const url = await subscriptionCheckoutUrl(billingOrganizationId, principal.userId!, plan, interval);
  captureProductEvent(principal, { event: 'checkout_started', target_plan: plan, interval });
  return url;
}

export async function startSubscription(plan: PlanId, interval: BillingInterval): Promise<void> {
  redirect(await checkoutUrl(plan, interval));
}

export async function startSubscriptionForm(plan: PlanId, interval: BillingInterval, _state: BillingActionState, _form: FormData): Promise<BillingActionState> {
  return startProjectSubscriptionForm(undefined, plan, interval, _state, _form);
}

export async function startProjectSubscriptionForm(projectId: string | undefined, plan: PlanId, interval: BillingInterval, _state: BillingActionState, _form: FormData): Promise<BillingActionState> {
  let url: string;
  try { url = await checkoutUrl(plan, interval, projectId); }
  catch { return { error: 'Checkout could not be opened. Please try again or contact support.' }; }
  redirect(url);
}

async function billingPortalUrl(projectId?: string): Promise<string> {
  const principal = await sessionPrincipal(projectId);
  requireOwner(principal.role);
  const entitlement = await getOrganizationEntitlement(principal.organizationId);
  const organization = await requireOrganizationAdmin(principal.userId!, entitlement.billingOrganizationId ?? principal.organizationId);
  requireOwner(organization.role);
  if (!entitlement.providerCustomerId) throw new Error('No billing customer exists for this workspace.');
  const portal = await stripeClient().billingPortal.sessions.create({
    customer: entitlement.providerCustomerId,
    configuration: env().STRIPE_BILLING_PORTAL_CONFIGURATION_ID,
    return_url: new URL('/dashboard/billing', env().ADPORT_CLOUD_BASE_URL).toString(),
  });
  return portal.url;
}

export async function openBillingPortal(): Promise<void> {
  redirect(await billingPortalUrl());
}

export async function openBillingPortalForm(_state: BillingActionState, _form: FormData): Promise<BillingActionState> {
  return openProjectBillingPortalForm(undefined, _state, _form);
}

export async function openProjectBillingPortalForm(projectId: string | undefined, _state: BillingActionState, _form: FormData): Promise<BillingActionState> {
  let url: string;
  try { url = await billingPortalUrl(projectId); }
  catch { return { error: 'Billing could not be opened. Please try again or contact support.' }; }
  redirect(url);
}
