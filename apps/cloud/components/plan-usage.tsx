import Link from 'next/link';
import { InfoTooltip } from './info-tooltip';
import type { PlanDefinition } from '@/lib/cloud/plans';
import type { OrganizationUsage } from '@/lib/cloud/usage';
import { selectProjectAction } from '@/app/dashboard/projects/actions';
import { PendingButton } from './pending-button';

function allowance(used: number, limit: number | null) {
  return limit === null ? used + ' / unlimited' : used + ' / ' + limit;
}

function UsageBar({ used, limit }: { used: number; limit: number | null }) {
  const percent = limit === null ? 0 : Math.min(100, Math.max(0, used / Math.max(1, limit) * 100));
  return <span className="usage-bar" data-full={limit !== null && used >= limit} aria-hidden="true"><span style={{ width: percent + '%' }} /></span>;
}

export function SidebarPlanUsage({ plan, usage }: { plan: PlanDefinition; usage: OrganizationUsage }) {
  return <Link href="/dashboard/billing#usage" className="sidebar-plan" prefetch={false} aria-label={plan.name + ' plan and usage: ' + allowance(usage.enabledAccounts, plan.maxActiveAccounts) + ' enabled ad accounts, ' + allowance(usage.editingMembers, plan.maxMembers) + ' team seats'}>
    <span className="sidebar-plan-title"><strong>{plan.name} plan</strong><span>Usage ↗</span></span>
    <span className="sidebar-plan-count"><span>Enabled ad accounts</span><strong>{allowance(usage.enabledAccounts, plan.maxActiveAccounts)}</strong></span>
    <UsageBar used={usage.enabledAccounts} limit={plan.maxActiveAccounts} />
    <span className="sidebar-plan-count"><span>Team seats</span><strong>{allowance(usage.editingMembers, plan.maxMembers)}</strong></span>
  </Link>;
}

export function PlanUsage({ plan, usage, organizationName, canManage, projectUsage, currentProjectId }: { plan: PlanDefinition; usage: OrganizationUsage; organizationName: string; canManage: boolean; projectUsage?: Array<{ id: string; name: string; enabledAccounts: number }>; currentProjectId?: string }) {
  return <section className="card plan-usage" id="usage" aria-label="Plan usage">
    <div className="card-head"><h2>Usage</h2><InfoTooltip label="About organization usage">Allowances are shared across every project in {organizationName}. Each enabled ad account in a project uses one account slot. Analytics and tracking connections do not use ad-account slots. Owners, admins, and editing members use team seats. Read-only viewers are free.</InfoTooltip></div>
    <div className="usage-grid">
      <div className="usage-metric"><span>Enabled ad accounts</span><strong>{allowance(usage.enabledAccounts, plan.maxActiveAccounts)}</strong><UsageBar used={usage.enabledAccounts} limit={plan.maxActiveAccounts} /><Link href="/dashboard/accounts">Manage accounts ↗</Link></div>
      <div className="usage-metric"><span>Team seats</span><strong>{allowance(usage.editingMembers, plan.maxMembers)}</strong><UsageBar used={usage.editingMembers} limit={plan.maxMembers} />{canManage ? <Link href="/dashboard/organization">Manage team ↗</Link> : <small>Owners, admins, and editors</small>}</div>
      <div className="usage-metric"><span>Projects</span><strong>{usage.projects}</strong><small>Unlimited on every plan</small><Link href="/dashboard/projects">View projects ↗</Link></div>
      <div className="usage-metric"><span>Read-only viewers</span><strong>{usage.viewers}</strong><small>Free, with read-only access</small></div>
    </div>
    <p className="usage-scope">Across all projects in {organizationName}</p>
    {projectUsage && projectUsage.length > 1 ? <div className="project-usage-breakdown"><h3>Enabled ad accounts by project</h3><div className="row-list">{projectUsage.map(project => <div className="row-item" key={project.id}><div><strong>{project.name}</strong>{project.id === currentProjectId ? <span className="cell-sub">This project</span> : null}</div><div className="row-actions"><span className="usage-project-count">{project.enabledAccounts} enabled</span>{project.id === currentProjectId ? <Link href="/dashboard/accounts" className="link-button">Manage accounts ↗</Link> : <form action={selectProjectAction}><input type="hidden" name="projectId" value={project.id} /><input type="hidden" name="return_to" value="/dashboard/accounts" /><PendingButton className="link-button" pendingLabel="Opening…">Manage accounts ↗</PendingButton></form>}</div></div>)}</div></div> : null}
  </section>;
}
