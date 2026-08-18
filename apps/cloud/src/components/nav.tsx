'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type NavItem = { label: string; href: string; icon: React.ReactNode };

const icon = {
  overview: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" /></svg>,
  connections: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 14.5 14.5 9.5" /><path d="M12.5 6.8 14 5.3a3.9 3.9 0 0 1 5.5 5.5l-2.4 2.4" /><path d="M11.5 17.2 10 18.7a3.9 3.9 0 0 1-5.5-5.5l2.4-2.4" /></svg>,
  accounts: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5h16v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-10Z" /><path d="M8 8.5v-2A2.5 2.5 0 0 1 10.5 4h3A2.5 2.5 0 0 1 16 6.5v2" /><path d="M4 13h16" /></svg>,
  reports: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V10" /><path d="M12 20V4" /><path d="M19 20v-7" /></svg>,
  findings: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m20 20-4.9-4.9" /><path d="M10.5 8v2.8" /><path d="M10.5 13.5h.01" /></svg>,
  approvals: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.2 2.4 2.4 4.6-4.9" /></svg>,
  audit: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5h10A1.5 1.5 0 0 1 18.5 6v13.5l-3-1.8-3.5 1.8-3.5-1.8-3 1.8V6A1.5 1.5 0 0 1 7 4.5Z" /><path d="M9 9h6" /><path d="M9 12.5h6" /></svg>,
  policies: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 19 6v5.5c0 4.4-2.9 7.6-7 9-4.1-1.4-7-4.6-7-9V6l7-2.5Z" /><path d="m9.3 11.8 2 2 3.4-3.6" /></svg>,
};

const sections: { label: string; items: NavItem[] }[] = [
  { label: 'Workspace', items: [
    { label: 'Overview', href: '/overview', icon: icon.overview },
  ] },
  { label: 'Inventory', items: [
    { label: 'Connections', href: '/connections', icon: icon.connections },
    { label: 'Accounts', href: '/accounts', icon: icon.accounts },
  ] },
  { label: 'Evidence', items: [
    { label: 'Reports', href: '/reports', icon: icon.reports },
    { label: 'Findings', href: '/findings', icon: icon.findings },
  ] },
  { label: 'Governance', items: [
    { label: 'Approvals', href: '/approvals', icon: icon.approvals },
    { label: 'Audit log', href: '/audit', icon: icon.audit },
    { label: 'Policies', href: '/policies', icon: icon.policies },
  ] },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Cloud navigation">
      {sections.map((section) => (
        <div key={section.label} style={{ display: 'contents' }}>
          <div className="nav-label">{section.label}</div>
          {section.items.map((item) => (
            <Link key={item.href} href={item.href} aria-current={pathname.startsWith(item.href) ? 'page' : undefined}>
              {item.icon}
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
