export const ANALYTICS_PAGES = ['overview', 'onboarding', 'connections', 'accounts', 'agents', 'reports', 'findings', 'audit', 'approvals', 'billing', 'projects', 'organization', 'policies', 'team'] as const;

// Never pass raw URLs, query strings, project names, or arbitrary route segments.
export function analyticsPage(pathname: string): typeof ANALYTICS_PAGES[number] | undefined {
  if (pathname === '/onboarding') return 'onboarding';
  if (pathname === '/dashboard') return 'overview';
  const segment = /^\/dashboard\/([^/]+)$/.exec(pathname)?.[1];
  return ANALYTICS_PAGES.find(page => page === segment);
}
