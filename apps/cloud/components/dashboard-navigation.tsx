'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useLayoutEffect, useOptimistic, useRef, useTransition, type ComponentProps, type ReactNode } from 'react';
import { RouteLoading } from './route-loading';

const ROUTES: Record<string, [string, 'grid' | 'list']> = {
  '/dashboard': ['Overview', 'grid'],
  '/dashboard/accounts': ['Ad accounts', 'list'],
  '/dashboard/analytics': ['Analytics & tracking', 'list'],
  '/dashboard/connections': ['Ad platforms', 'list'],
  '/dashboard/agents': ['AI assistants', 'list'],
  '/dashboard/assets': ['Creative library', 'grid'],
  '/dashboard/approvals': ['Approvals', 'list'],
  '/dashboard/audit': ['History', 'list'],
  '/dashboard/reports': ['Campaign report', 'list'],
  '/dashboard/findings': ['Findings', 'list'],
  '/dashboard/projects': ['Projects', 'list'],
  '/dashboard/organization': ['Organization', 'list'],
  '/dashboard/team': ['Project team', 'list'],
  '/dashboard/developer': ['Developer settings', 'list'],
  '/dashboard/policies': ['Policies', 'list'],
  '/dashboard/preferences': ['Account settings', 'list'],
  '/dashboard/billing': ['Plan & billing', 'grid'],
  '/account-selection': ['Choose accounts', 'list'],
};

const NavigationContext = createContext<{ path: string; destination: string | null; navigate(href: string): boolean } | null>(null);

export function DashboardNavigation({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [destination, setDestination] = useOptimistic<string | null>(null);
  const [, startTransition] = useTransition();
  function navigate(href: string) {
    const target = href.split('#', 1)[0]!;
    const path = target.split('?', 1)[0]!;
    if (!Object.hasOwn(ROUTES, path) || target === window.location.pathname + window.location.search) return false;
    startTransition(() => { setDestination(target); router.push(href); });
    return true;
  }
  return <NavigationContext.Provider value={{ path: destination?.split('?', 1)[0] ?? pathname, destination, navigate }}>{children}</NavigationContext.Provider>;
}

export function useDashboardPath(fallback: string) {
  return useContext(NavigationContext)?.path ?? fallback;
}

export function DashboardLink({ href, onNavigate, ...props }: Omit<ComponentProps<typeof Link>, 'href'> & { href: string }) {
  const navigation = useContext(NavigationContext);
  return <Link {...props} href={href} onNavigate={event => {
    let prevented = false;
    onNavigate?.({ preventDefault: () => { prevented = true; event.preventDefault(); } });
    if (!prevented && navigation?.navigate(href)) event.preventDefault();
  }} />;
}

export function DashboardContent({ children }: { children: ReactNode }) {
  const navigation = useContext(NavigationContext);
  const scroller = useRef<HTMLDivElement>(null);
  const previousPath = useRef(navigation?.path);
  useLayoutEffect(() => {
    if (navigation?.destination || previousPath.current !== navigation?.path) {
      previousPath.current = navigation?.path;
      if ((navigation?.destination || !window.location.hash) && scroller.current) scroller.current.scrollTop = 0;
    }
  }, [navigation?.path, navigation?.destination]);
  const destination = navigation?.destination ? ROUTES[navigation.path] : undefined;
  return <div className="dashboard-scroll" id="content" tabIndex={-1} ref={scroller}>
    {destination ? <RouteLoading title={destination[0]} label={`Loading ${destination[0]}`} layout={destination[1]} /> : null}
    <div hidden={Boolean(destination)}>{children}</div>
  </div>;
}
