import { Button, Chevron } from '@/components/controls';
import { DashboardContent, DashboardLink, DashboardNavigation } from '@/components/dashboard-navigation';
import { signOut } from '@/app/dashboard/actions';
import { BrandLockup } from '@/components/logos';
import { ContextNav, Nav, SidebarFrame, UtilityNav } from '@/components/nav';
import { SupportWidget } from '@/components/support-widget';
import { ProfileAvatar } from '@/components/profile-identity';

export interface ShellTenant {
  organizationName: string;
  userName: string;
  avatarUrl: string | null;
  role: string;
  organizationRole: string;
  projectSwitcher?: React.ReactNode;
  planUsage?: React.ReactNode;
}

export function Shell({ tenant, pendingApprovals = 0, children }: { tenant: ShellTenant; pendingApprovals?: number; children: React.ReactNode }) {
  const canManageOrganization = ['owner', 'admin'].includes(tenant.organizationRole);
  return (
    <DashboardNavigation><div className="app-shell">
      <a className="skip-link" href="#content">Skip to content</a>
      <SidebarFrame
        brand={<DashboardLink className="brand-lockup" href="/dashboard" aria-label="Adport overview"><BrandLockup /></DashboardLink>}
        workspace={tenant.projectSwitcher ?? tenant.organizationName}
      >
        <Nav pendingApprovals={pendingApprovals} />
        <div className="sidebar-lower">{tenant.planUsage}<UtilityNav canManageOrganization={canManageOrganization} /></div>
        <div className="sidebar-foot">
          <DashboardLink className="user sidebar-account" href="/dashboard/preferences" aria-label="Account settings">
            <ProfileAvatar name={tenant.userName} avatarUrl={tenant.avatarUrl} />
            <span className="user-text">
              <span className="user-name">{tenant.userName}</span>
              <span className="user-sub">Account settings</span>
            </span>
            <Chevron direction="right" />
          </DashboardLink>
          <form action={signOut}>
            <Button className="link-button" type="submit">Sign out</Button>
          </form>
        </div>
      </SidebarFrame>
      <div className="main"><ContextNav canManage={['owner', 'admin'].includes(tenant.role)} canManageOrganization={canManageOrganization} /><DashboardContent>{children}</DashboardContent></div>
      <SupportWidget />
    </div></DashboardNavigation>
  );
}
