import 'server-only';
import { db } from '@/lib/db';
import { billingUpgradePath, type PlanLimitDetails } from './plan-limit';
import catalog from './plan-catalog.json';
import type { TenantPrincipal } from './types';

export async function adWritePlanLimit(principal: TenantPrincipal, baseUrl: string): Promise<PlanLimitDetails | undefined> {
  if (principal.scopes.includes('tools:write') || principal.role === 'viewer' || !principal.grantedScopes?.includes('tools:write')
    || !principal.entitlement || principal.entitlement.writeAccess) return;
  const memberships = principal.userId ? await db()<Array<{ role: string }>>`
    select member.role from public.organization_group_memberships member
    join public.organizations project on project.organization_group_id = member.organization_group_id
    where project.id = ${principal.organizationId} and member.user_id = ${principal.userId} and project.archived_at is null
  ` : [];
  const canManageBilling = memberships[0]?.role === 'owner';
  const recommendedPlan = 'operator';
  const upgradeUrl = new URL(billingUpgradePath({ kind: 'write_access', recommendedPlan, projectId: principal.organizationId }), baseUrl).href;
  const plan = catalog[recommendedPlan];
  return {
    kind: 'write_access', currentPlan: principal.entitlement.planName, recommendedPlan, upgradeUrl, canManageBilling, projectId: principal.organizationId,
    message: `${principal.entitlement.planName} includes read-only ad tools. Previewing and applying ad changes requires ${plan.name} (€${plan.monthlyPriceEur}/month) or higher. ${canManageBilling ? 'Review upgrade options' : 'Ask your organization owner to upgrade; share these plan details'}: ${upgradeUrl}. No changes were made.`,
  };
}
