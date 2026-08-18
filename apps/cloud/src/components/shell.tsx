import Link from 'next/link';
import type { CloudTenant } from '@/lib/store';
import { signOut } from '@/app/actions';
import { BrandLockup } from '@/components/logos';
import { Nav } from '@/components/nav';

export function Shell({ tenant, children }: { tenant: CloudTenant; children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand-lockup" href="/overview" aria-label="Adport Cloud overview">
          <BrandLockup sub="Control plane" />
        </Link>
        <Nav />
        <div className="sidebar-foot">
          <span className="availability"><i aria-hidden="true" /> read-first</span>
          Every write is previewed, approved, and audited before it runs.
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="workspace">
            <span className="workspace-label">Workspace</span>
            <span className="workspace-name">{tenant.workspaceName}</span>
          </div>
          <div className="topbar-meta">
            <div className="user">
              <span className="user-name">{tenant.name}</span>
              <span className="user-role">{tenant.role}</span>
              <span className="avatar" aria-hidden="true">{tenant.name.slice(0, 1)}</span>
            </div>
            <form action={signOut}>
              <button className="link-button" type="submit">Sign out</button>
            </form>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
