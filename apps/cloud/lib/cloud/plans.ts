import 'server-only';
import { db } from '@/lib/db';
import type { TenantPrincipal } from './types';

export const PLAN_IDS = ['reader', 'operator', 'agency', 'enterprise'] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export type BillingInterval = 'monthly' | 'annual';
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete' | 'unpaid';

export interface PlanDefinition {
  id: PlanId;
  name: string;
  monthlyPriceEur: number | null;
  annualPriceEur: number | null;
  maxActiveAccounts: number | null;
  maxMembers: number | null;
  maxRetentionDays: number;
  writeAccess: boolean;
  clientWorkspaces: boolean;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  reader: {
    id: 'reader', name: 'Free', monthlyPriceEur: 0, annualPriceEur: 0, maxActiveAccounts: 3, maxMembers: 1,
    maxRetentionDays: 30, writeAccess: false, clientWorkspaces: false,
  },
  operator: {
    id: 'operator', name: 'Operator', monthlyPriceEur: 29, annualPriceEur: 290, maxActiveAccounts: 5, maxMembers: 2,
    maxRetentionDays: 90, writeAccess: true, clientWorkspaces: false,
  },
  agency: {
    id: 'agency', name: 'Agency', monthlyPriceEur: 199, annualPriceEur: 1990, maxActiveAccounts: 25, maxMembers: 10,
    maxRetentionDays: 365, writeAccess: true, clientWorkspaces: true,
  },
  enterprise: {
    id: 'enterprise', name: 'Enterprise', monthlyPriceEur: null, annualPriceEur: null, maxActiveAccounts: null, maxMembers: null,
    maxRetentionDays: 3650, writeAccess: true, clientWorkspaces: true,
  },
};

export interface OrganizationEntitlement {
  plan: PlanDefinition;
  status: SubscriptionStatus;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export async function getOrganizationEntitlement(organizationId: string): Promise<OrganizationEntitlement> {
  const rows = await db()<Array<{
    plan: PlanId;
    status: SubscriptionStatus;
    providerCustomerId: string | null;
    providerSubscriptionId: string | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
  }>>`
    select plan, status, provider_customer_id, provider_subscription_id, current_period_end, cancel_at_period_end
    from public.organization_subscriptions
    where organization_id = ${organizationId}
    limit 1
  `;
  const subscription = rows[0] ?? {
    plan: 'reader' as const,
    status: 'active' as const,
    providerCustomerId: null,
    providerSubscriptionId: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  };
  const entitledPlan = ['active', 'trialing', 'past_due'].includes(subscription.status) ? subscription.plan : 'reader';
  return { ...subscription, plan: PLANS[entitledPlan] };
}

export async function applyPlanToPrincipal(principal: TenantPrincipal): Promise<TenantPrincipal> {
  const [entitlement, membership] = await Promise.all([
    getOrganizationEntitlement(principal.organizationId),
    principal.userId && !principal.role
      ? db()<Array<{ role: NonNullable<TenantPrincipal['role']> }>>`
          select role from public.organization_memberships
          where organization_id = ${principal.organizationId} and user_id = ${principal.userId}
          limit 1
        `
      : Promise.resolve([]),
  ]);
  const role = principal.role ?? membership[0]?.role;
  const writeAllowed = entitlement.plan.writeAccess && role !== 'viewer';
  return {
    ...principal,
    role,
    scopes: principal.scopes.filter((scope) => scope !== 'tools:write' || writeAllowed),
  };
}

export function formatPlanLimit(value: number | null, unit: string): string {
  if (value === null) return `Unlimited ${unit}`;
  return `${value} ${value === 1 ? unit.replace(/s$/, '') : unit}`;
}
