import { DashboardLink as Link } from '@/components/dashboard-navigation';
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
  return <Link href="/dashboard/billing#usage" className="sidebar-plan" aria-label={plan.name + ' plan and usage: ' + allowance(usage.enabledAccounts, plan.maxActiveAccounts) + ' enabled ad accounts, ' + allowance(usage.editingMembers, plan.maxMembers) + ' team seats'}>
    <span className="sidebar-plan-title"><strong>{plan.name} plan</strong><span>Usage ↗</span></span>
    <span className="sidebar-plan-count"><span>Enabled ad accounts</span><strong>{allowance(usage.enabledAccounts, plan.maxActiveAccounts)}</strong></span>
    <UsageBar used={usage.enabledAccounts} limit={plan.maxActiveAccounts} />
    <span className="sidebar-plan-count"><span>Team seats</span><strong>{allowance(usage.editingMembers, plan.maxMembers)}</strong></span>
  </Link>;
}

export function PlanUsage({ plan, usage, organizationName, canManage, projectUsage, currentProjectId }: { plan: PlanDefinition; usage: OrganizationUsage; organizationName: string; canManage: boolean; projectUsage?: Array<{ id: string; name: string; enabledAccounts: number }>; currentProjectId?: string }) {
  return <section className="settings-section plan-usage" id="usage" aria-labelledby="plan-usage-heading">
    <div className="settings-section-head"><h2 id="plan-usage-heading">Usage <InfoTooltip label="About organization usage">Allowances are shared across every project in {organizationName}. Each enabled ad account in a project uses one account slot. Analytics and tracking connections do not use ad-account slots. Owners, admins, and editing members use team seats. Read-only viewers are free.</InfoTooltip></h2></div>
    <ul className="settings-list">
      <li className="settings-row usage-row">
        <strong>Enabled ad accounts</strong>
        <div className="usage-row-value"><span>{allowance(usage.enabledAccounts, plan.maxActiveAccounts)}</span>{plan.maxActiveAccounts !== null ? <UsageBar used={usage.enabledAccounts} limit={plan.maxActiveAccounts} /> : null}</div>
        <Link className="link-button settings-link" href="/dashboard/accounts">Manage accounts</Link>
      </li>
      <li className="settings-row usage-row">
        <strong>Team seats</strong>
        <div className="usage-row-value"><span>{allowance(usage.editingMembers, plan.maxMembers)}</span>{plan.maxMembers !== null ? <UsageBar used={usage.editingMembers} limit={plan.maxMembers} /> : null}</div>
        {canManage ? <Link className="link-button settings-link" href="/dashboard/organization">Manage team</Link> : null}
      </li>
      <li className="settings-row usage-row">
        <strong>Projects</strong>
        <div className="usage-row-value">{allowance(usage.projects, null)}</div>
        <Link className="link-button settings-link" href="/dashboard/projects">View projects</Link>
      </li>
      <li className="settings-row usage-row">
        <strong>Read-only viewers</strong>
        <div className="usage-row-value">{usage.viewers}</div>
      </li>
    </ul>
    {projectUsage && projectUsage.length > 1 ? <section className="project-usage-breakdown" aria-labelledby="project-usage-heading">
      <h3 id="project-usage-heading">Enabled ad accounts by project</h3>
      <ul className="settings-list">{projectUsage.map(project => <li className="settings-row" key={project.id}>
        <div className="settings-row-copy"><strong>{project.name}</strong>{project.id === currentProjectId ? <p className="settings-note">This project</p> : null}</div>
        <div className="settings-row-actions">
          <span className="usage-project-count">{project.enabledAccounts} enabled</span>
          {project.id === currentProjectId ? <Link href="/dashboard/accounts" className="link-button settings-link">Manage accounts</Link>
            : <form action={selectProjectAction}>
              <input type="hidden" name="projectId" value={project.id} />
              <input type="hidden" name="return_to" value="/dashboard/accounts" />
              <PendingButton className="link-button settings-link" pendingLabel="Opening…">Manage accounts</PendingButton>
            </form>}
        </div>
      </li>)}</ul>
    </section> : null}
  </section>;
}
