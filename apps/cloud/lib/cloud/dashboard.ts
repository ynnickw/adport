import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { TenantPrincipal } from './types';

export interface DashboardTenant {
  userId: string;
  userName: string;
  email: string;
  organizationId: string;
  organizationName: string;
  role: NonNullable<TenantPrincipal['role']>;
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
  const { data: memberships } = await supabase
    .from('organization_memberships')
    .select('organization_id, role, organizations(name)')
    .order('created_at', { ascending: true })
    .limit(1);
  const membership = memberships?.[0];
  if (!membership) throw new Error('No organization membership found for this account.');
  const organization = membership.organizations as unknown as { name: string } | { name: string }[] | null;
  const organizationName = Array.isArray(organization) ? organization[0]?.name : organization?.name;
  const meta = auth.user.user_metadata as { full_name?: string } | null;
  return {
    userId: auth.user.id,
    userName: meta?.full_name?.trim() || auth.user.email?.split('@')[0] || 'Member',
    email: auth.user.email ?? '',
    organizationId: membership.organization_id,
    organizationName: organizationName ?? 'Workspace',
    role: membership.role as DashboardTenant['role'],
  };
});

export function canAdminister(tenant: Pick<DashboardTenant, 'role'>): boolean {
  return tenant.role === 'owner' || tenant.role === 'admin';
}
