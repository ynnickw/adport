import Link from 'next/link';
import { signOut } from '@/app/dashboard/actions';
import { BrandLockup } from '@/components/logos';
import { Nav } from '@/components/nav';

export interface ShellTenant {
  organizationName: string;
  userName: string;
  email: string;
  role: string;
}

export function Shell({ tenant, children }: { tenant: ShellTenant; children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-head">
          <Link className="brand-lockup" href="/dashboard" aria-label="Adport overview">
            <BrandLockup />
          </Link>
          <div className="workspace">
            <span className="workspace-name">{tenant.organizationName}</span>
          </div>
        </div>
        <Nav />
        <div className="sidebar-foot">
          <div className="user">
            <span className="avatar" aria-hidden="true">{tenant.userName.slice(0, 1).toUpperCase()}</span>
            <span className="user-text">
              <span className="user-name">{tenant.userName}</span>
              <span className="user-sub">{tenant.role} · {tenant.email}</span>
            </span>
          </div>
          <form action={signOut}>
            <button className="button secondary small full" type="submit">Sign out</button>
          </form>
        </div>
      </aside>
      <div className="main">{children}</div>
    </div>
  );
}
