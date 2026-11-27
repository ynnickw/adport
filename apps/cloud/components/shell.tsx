import { Button } from '@/components/controls';
import { DashboardContent, DashboardLink, DashboardNavigation } from '@/components/dashboard-navigation';
import { signOut } from '@/app/dashboard/actions';
import { BrandLockup } from '@/components/logos';
import { ContextNav, Nav, SidebarFrame, UtilityNav } from '@/components/nav';
import { SupportWidget } from '@/components/support-widget';

export interface ShellTenant {
  organizationName: string;
  userName: string;
  email: string;
  role: string;
  projectSwitcher?: React.ReactNode;
  planUsage?: React.ReactNode;
}

export function Shell({ tenant, pendingApprovals = 0, children }: { tenant: ShellTenant; pendingApprovals?: number; children: React.ReactNode }) {
  return (
    <DashboardNavigation><div className="app-shell">
      <a className="skip-link" href="#content">Skip to content</a>
      <SidebarFrame
        brand={<DashboardLink className="brand-lockup" href="/dashboard" aria-label="Adport overview"><BrandLockup /></DashboardLink>}
        workspace={tenant.projectSwitcher ?? tenant.organizationName}
      >
        <Nav pendingApprovals={pendingApprovals} />
        <div className="sidebar-lower">{tenant.planUsage}<UtilityNav /></div>
        <div className="sidebar-foot">
          <div className="user">
            <span className="avatar" aria-hidden="true">{tenant.userName.slice(0, 1).toUpperCase()}</span>
            <span className="user-text">
              <span className="user-name">{tenant.userName}</span>
              <span className="user-sub">{tenant.email}</span>
            </span>
          </div>
          <DashboardLink className="link-button sidebar-preferences" href="/dashboard/preferences">Preferences</DashboardLink>
          <form action={signOut}>
            <Button className="link-button" type="submit">Sign out</Button>
          </form>
        </div>
      </SidebarFrame>
      <div className="main"><ContextNav canManage={['owner', 'admin'].includes(tenant.role)} /><DashboardContent>{children}</DashboardContent></div>
      <SupportWidget />
    </div></DashboardNavigation>
  );
}
