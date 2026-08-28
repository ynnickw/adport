import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import type { TenantPrincipal } from './types';

export interface DashboardTenant {
  userId: string;
  userName: string;
  email: string;
  organizationId: string;
  organizationName: string;
  role: NonNullable<TenantPrincipal['role']>;
  onboardingCompletedAt: Date | null;
}

/**
 * Resolve the signed-in user's organization for dashboard rendering. Cached
 * per request so the layout and page share one Supabase round-trip. Redirects
 * to the sign-in screen when there is no session.
 */
export const requireDashboardTenant = cache(async (): Promise<DashboardTenant> => {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect('/');
  const memberships = await db()<Array<{
    organizationId: string;
    role: DashboardTenant['role'];
    organizationName: string;
    onboardingCompletedAt: Date | null;
  }>>`
    select membership.organization_id, membership.role, organization.name as organization_name,
      onboarding.completed_at as onboarding_completed_at
    from public.organization_memberships membership
    join public.organizations organization on organization.id = membership.organization_id
    left join public.organization_onboarding onboarding on onboarding.organization_id = organization.id
    where membership.user_id = ${auth.user.id}
    order by membership.created_at asc
    limit 1
  `;
  const membership = memberships[0];
  if (!membership) throw new Error('No organization membership found for this account.');
  const meta = auth.user.user_metadata as { full_name?: string } | null;
  return {
    userId: auth.user.id,
    userName: meta?.full_name?.trim() || auth.user.email?.split('@')[0] || 'Member',
    email: auth.user.email ?? '',
    organizationId: membership.organizationId,
    organizationName: membership.organizationName,
    role: membership.role as DashboardTenant['role'],
    onboardingCompletedAt: membership.onboardingCompletedAt,
  };
});

export function canAdminister(tenant: Pick<DashboardTenant, 'role'>): boolean {
  return tenant.role === 'owner' || tenant.role === 'admin';
}
