import { Button } from '@/components/controls';
import Link from 'next/link';
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
}

export function Shell({ tenant, pendingApprovals = 0, children }: { tenant: ShellTenant; pendingApprovals?: number; children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">Skip to content</a>
      <SidebarFrame
        brand={<Link className="brand-lockup" href="/dashboard" prefetch={false} aria-label="Adport overview"><BrandLockup /></Link>}
        workspace={tenant.projectSwitcher ?? tenant.organizationName}
      >
        <Nav pendingApprovals={pendingApprovals} />
        <div className="sidebar-lower"><UtilityNav /></div>
        <div className="sidebar-foot">
          <div className="user">
            <span className="avatar" aria-hidden="true">{tenant.userName.slice(0, 1).toUpperCase()}</span>
            <span className="user-text">
              <span className="user-name">{tenant.userName}</span>
              <span className="user-sub">{tenant.email}</span>
            </span>
          </div>
          <form action={signOut}>
            <Button className="link-button" type="submit">Sign out</Button>
          </form>
        </div>
      </SidebarFrame>
      <div className="main" id="content" tabIndex={-1}><ContextNav projectName={tenant.organizationName} />{children}</div>
      <SupportWidget />
    </div>
  );
}
