'use client';

import { Button } from '@/components/controls';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

type NavItem = { label: string; href: string; icon: React.ReactNode; exact?: boolean; badge?: number; paths?: string[] };

const icon = {
  overview: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" /></svg>,
  connections: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 14.5 14.5 9.5" /><path d="M12.5 6.8 14 5.3a3.9 3.9 0 0 1 5.5 5.5l-2.4 2.4" /><path d="M11.5 17.2 10 18.7a3.9 3.9 0 0 1-5.5-5.5l2.4-2.4" /></svg>,
  accounts: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5h16v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-10Z" /><path d="M8 8.5v-2A2.5 2.5 0 0 1 10.5 4h3A2.5 2.5 0 0 1 16 6.5v2" /><path d="M4 13h16" /></svg>,
  reports: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V10" /><path d="M12 20V4" /><path d="M19 20v-7" /></svg>,
  findings: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 20 8v8l-8 4.5L4 16V8l8-4.5Z" /><path d="M8.5 11.8 11 14l4.5-4.5" /></svg>,
  approvals: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.2 2.4 2.4 4.6-4.9" /></svg>,
  audit: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5h10A1.5 1.5 0 0 1 18.5 6v13.5l-3-1.8-3.5 1.8-3.5-1.8-3 1.8V6A1.5 1.5 0 0 1 7 4.5Z" /><path d="M9 9h6" /><path d="M9 12.5h6" /></svg>,
  policies: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 19 6v5.5c0 4.4-2.9 7.6-7 9-4.1-1.4-7-4.6-7-9V6l7-2.5Z" /><path d="m9.3 11.8 2 2 3.4-3.6" /></svg>,
  team: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19.5c.4-3.1 2.7-5 5.5-5s5.1 1.9 5.5 5" /><circle cx="16.5" cy="9.5" r="2.4" /><path d="M15.2 14.6c2.6.1 4.6 1.8 5.1 4.6" /></svg>,
  agents: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 9.5 5 12l3.5 2.5" /><path d="m15.5 9.5 3.5 2.5-3.5 2.5" /><path d="m13.2 6.5-2.4 11" /></svg>,
  billing: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="M3.5 9.5h17" /><path d="M7.5 14.5h3" /></svg>,
  support: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M8.2 8.2 6 6" /><path d="m15.8 8.2 2.2-2.2" /><path d="m8.2 15.8-2.2 2.2" /><path d="m15.8 15.8 2.2 2.2" /><circle cx="12" cy="12" r="3.4" /></svg>,
};

const PRIMARY_ITEMS: NavItem[] = [
  { label: 'Overview', href: '/dashboard', icon: icon.overview, exact: true },
  { label: 'AI assistants', href: '/dashboard/agents', icon: icon.agents },
  { label: 'Accounts', href: '/dashboard/accounts', icon: icon.accounts, paths: ['/dashboard/accounts', '/dashboard/connections', '/dashboard/analytics'] },
  { label: 'Creative library', href: '/dashboard/assets', icon: icon.reports },
  { label: 'Approvals', href: '/dashboard/approvals', icon: icon.approvals, paths: ['/dashboard/approvals', '/dashboard/audit'] },
];

const SETTINGS_ITEMS: NavItem[] = [
  { label: 'Projects', href: '/dashboard/projects', icon: icon.accounts },
  { label: 'Organization', href: '/dashboard/organization', icon: icon.team },
  { label: 'Project team', href: '/dashboard/team', icon: icon.team },
  { label: 'Policies', href: '/dashboard/policies', icon: icon.policies },
  { label: 'Plan & usage', href: '/dashboard/billing', icon: icon.billing },
  { label: 'Preferences', href: '/dashboard/preferences', icon: icon.policies },
];
const UTILITY_ITEMS: NavItem[] = [
  { label: 'Settings', href: '/dashboard/preferences', icon: icon.policies, paths: SETTINGS_ITEMS.map(item => item.href) },
];

const isActive = (item: NavItem, pathname: string) => item.exact ? pathname === item.href : (item.paths ?? [item.href]).some(path => pathname === path || pathname.startsWith(`${path}/`));

function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return items.map((item) => {
    const active = isActive(item, pathname);
    return (
      <Link key={item.href} href={item.href} prefetch={false} aria-current={active ? 'page' : undefined}>
        {item.icon}{item.label}
        {item.badge ? <span className="nav-badge"><span aria-hidden="true">{item.badge}</span><span className="sr-only">, {item.badge} waiting</span></span> : null}
      </Link>
    );
  });
}

export function Nav({ pendingApprovals = 0 }: { pendingApprovals?: number }) {
  const items = PRIMARY_ITEMS.map((item) => item.href === '/dashboard/approvals' ? { ...item, badge: pendingApprovals } : item);
  return <nav className="nav" aria-label="Cloud navigation"><NavLinks items={items} /></nav>;
}

export function UtilityNav() {
  return (
    <nav className="nav utility-nav" aria-label="Workspace and help">
      <NavLinks items={UTILITY_ITEMS} />
    </nav>
  );
}

export function ContextNav() {
  const pathname = usePathname();
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navigation.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const reveal = () => {
      const parent = nav.getBoundingClientRect();
      const item = active.getBoundingClientRect();
      if (item.left < parent.left) nav.scrollLeft += item.left - parent.left;
      else if (item.right > parent.right) nav.scrollLeft += item.right - parent.right;
    };
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    reveal();
    return () => observer.disconnect();
  }, [pathname]);
  const tabs = SETTINGS_ITEMS.some(item => isActive(item, pathname)) ? SETTINGS_ITEMS
    : ['/dashboard/accounts', '/dashboard/connections', '/dashboard/analytics'].includes(pathname)
      ? [{ label: 'Ad accounts', href: '/dashboard/accounts' }, { label: 'Ad platforms', href: '/dashboard/connections' }, { label: 'Analytics & tracking', href: '/dashboard/analytics' }]
      : ['/dashboard/approvals', '/dashboard/audit'].includes(pathname)
        ? [{ label: 'Pending changes', href: '/dashboard/approvals' }, { label: 'History', href: '/dashboard/audit' }] : [];
  if (!tabs.length) return null;
  return <header className="workspace-bar">
    <nav ref={navigation} className="section-tabs" aria-label="Section navigation">{tabs.map(item => <Link href={item.href} key={item.href} prefetch={false} aria-current={pathname === item.href ? 'page' : undefined}>{item.label}</Link>)}</nav>
  </header>;
}

// On narrow screens the navigation collapses behind a menu button so each page starts with its content.
export function SidebarFrame({ brand, workspace, children }: { brand: React.ReactNode; workspace: React.ReactNode; children: React.ReactNode }) {
  const sidebar = useRef<HTMLElement>(null);
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current = [...PRIMARY_ITEMS, ...SETTINGS_ITEMS].find((item) => isActive(item, pathname))?.label ?? 'Menu';

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    const element = sidebar.current;
    const shell = element?.closest<HTMLElement>('.app-shell');
    if (!element || !shell || open) return;
    const measure = () => shell.style.setProperty('--mobile-nav-offset', element.getBoundingClientRect().height + 'px');
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <aside ref={sidebar} className="sidebar" data-open={open}>
      <div className="sidebar-head">
        {brand}
        <div className="workspace">{typeof workspace === 'string' ? <span className="workspace-name">{workspace}</span> : workspace}</div>
        <Button className="menu-toggle" type="button" aria-expanded={open} aria-controls="sidebar-menu" onClick={() => setOpen((value) => !value)}>
          <span className="menu-current">{current}</span>
          <span className="menu-icon" aria-hidden="true" />
          <span className="sr-only">{open ? 'Close navigation' : 'Open navigation'}</span>
        </Button>
      </div>
      <div className="sidebar-menu" id="sidebar-menu">{children}</div>
    </aside>
  );
}
