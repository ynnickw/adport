export const REQUEST_PATH_HEADER = 'x-adport-request-path';

export function safeDashboardReturnPath(value: FormDataEntryValue | null): string {
  const path = safeReturnPath(value);
  const pathname = new URL(path, 'https://adport.invalid').pathname;
  return pathname === '/dashboard' || pathname.startsWith('/dashboard/') ? path : '/dashboard';
}

export function safeReturnPath(value: FormDataEntryValue | null): string {
  const path = typeof value === 'string' ? value : '';
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return '/dashboard';
  try {
    const parsed = new URL(path, 'https://adport.invalid');
    return parsed.origin === 'https://adport.invalid' ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/dashboard';
  } catch {
    return '/dashboard';
  }
}
