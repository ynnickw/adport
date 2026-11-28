import type { TenantPrincipal } from './cloud/types';

export const TEAM_ROLES: Record<NonNullable<TenantPrincipal['role']>, { label: string; organization: string; project: string }> = {
  owner: {
    label: 'Owner',
    organization: 'Manages billing, people, organization settings, and all current and future projects.',
    project: 'Inherits access from the organization. Manages the project, its settings, and its team.',
  },
  admin: {
    label: 'Admin',
    organization: 'Manages people, projects, connections, and policies across the organization. Billing and admin access are managed by owners.',
    project: 'Manages connections, policies, and member and viewer access in this project.',
  },
  member: {
    label: 'Member',
    organization: 'Reads reports and proposes ad changes in assigned projects, within plan limits and project safeguards.',
    project: 'Reads reports and proposes ad changes, within plan limits and project safeguards.',
  },
  viewer: {
    label: 'Viewer',
    organization: 'Reads reports and history in assigned projects. Free and read-only.',
    project: 'Reads project reports and history. Free and read-only.',
  },
};
