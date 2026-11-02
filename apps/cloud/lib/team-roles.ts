import type { TenantPrincipal } from './cloud/types';

export const TEAM_ROLES: Record<NonNullable<TenantPrincipal['role']>, { label: string; description: string }> = {
  owner: { label: 'Owner', description: 'Manage billing, organization settings, people, and every project.' },
  admin: { label: 'Admin', description: 'Manage people, projects, connections, and policies across the organization. Owners manage billing and other admins.' },
  member: { label: 'Member', description: 'Read reports and manage ads in assigned projects, within your plan and project safeguards.' },
  viewer: { label: 'Viewer', description: 'Read reports and history in assigned projects. Cannot change ads, connections, settings, or team access.' },
};
