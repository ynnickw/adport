import 'server-only';
import { db } from '@/lib/db';
import type { TenantPrincipal } from './types';
import type { UpgradePlanId } from './plan-limit';
import { HttpError } from '@/lib/http';
import type postgres from 'postgres';

export const PLAN_IDS = ['reader', 'operator', 'premium', 'agency', 'enterprise'] as const;
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
    maxRetentionDays: 30, writeAccess: false, clientWorkspaces: true,
  },
  operator: {
    id: 'operator', name: 'Operator', monthlyPriceEur: 19, annualPriceEur: 190, maxActiveAccounts: 5, maxMembers: 2,
    maxRetentionDays: 90, writeAccess: true, clientWorkspaces: true,
  },
  premium: {
    id: 'premium', name: 'Premium', monthlyPriceEur: 79, annualPriceEur: 790, maxActiveAccounts: 15, maxMembers: 5,
    maxRetentionDays: 365, writeAccess: true, clientWorkspaces: true,
  },
  agency: {
    id: 'agency', name: 'Agency', monthlyPriceEur: 149, annualPriceEur: 1490, maxActiveAccounts: 40, maxMembers: 15,
    maxRetentionDays: 730, writeAccess: true, clientWorkspaces: true,
  },
  enterprise: {
    id: 'enterprise', name: 'Enterprise', monthlyPriceEur: null, annualPriceEur: null, maxActiveAccounts: null, maxMembers: null,
    maxRetentionDays: 3650, writeAccess: true, clientWorkspaces: true,
  },
};

export interface OrganizationEntitlement {
  billingOrganizationId?: string;
  plan: PlanDefinition;
  status: SubscriptionStatus;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export async function getOrganizationEntitlement(organizationId: string, sql: postgres.Sql | postgres.TransactionSql = db()): Promise<OrganizationEntitlement> {
  const rows = await sql<Array<{
    plan: PlanId;
    status: SubscriptionStatus;
    providerCustomerId: string | null;
    providerSubscriptionId: string | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    billingOrganizationId: string;
  }>>`
    select subscription.plan, subscription.status, subscription.provider_customer_id, subscription.provider_subscription_id,
      subscription.current_period_end, subscription.cancel_at_period_end, company.default_project_id as billing_organization_id
    from public.organizations project
    join public.organization_groups company on company.id = project.organization_group_id
    join public.organization_subscriptions subscription on subscription.organization_id = company.default_project_id
    where project.id = ${organizationId} and project.archived_at is null
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
          select role from private.project_memberships
          where organization_id = ${principal.organizationId} and user_id = ${principal.userId}
          limit 1
        `
      : Promise.resolve([]),
  ]);
  if (principal.userId && !principal.role && !membership.length) throw new HttpError('Project access has been revoked.', 403);
  const role = principal.role ?? membership[0]?.role;
  const writeAllowed = entitlement.plan.writeAccess && role !== 'viewer';
  return {
    ...principal,
    role,
    grantedScopes: principal.grantedScopes ?? principal.scopes,
    entitlement: {
      planId: entitlement.plan.id,
      planName: entitlement.plan.name,
      writeAccess: entitlement.plan.writeAccess,
    },
    scopes: principal.scopes.filter((scope) => scope !== 'tools:write' || writeAllowed),
  };
}

export function formatPlanLimit(value: number | null, unit: string): string {
  if (value === null) return `Unlimited ${unit}`;
  return `${value} ${value === 1 ? unit.replace(/s$/, '') : unit}`;
}

export function recommendedUpgradePlan(plan: PlanId): UpgradePlanId {
  if (plan === 'reader') return 'operator';
  if (plan === 'operator') return 'premium';
  if (plan === 'premium') return 'agency';
  return 'enterprise';
}
