import { safeDashboardReturnPath, safeReturnPath } from './return-path';

/** Keep the one-time picker in the flow that initiated authorization. */
export function accountSelectionPath(selectionId: string, returnPath: string, needsOnboarding = false): string {
  const source = new URL(safeReturnPath(returnPath), 'https://adport.invalid');
  if (source.pathname === '/onboarding' || needsOnboarding) {
    const query = new URLSearchParams({ selection_id: selectionId, resume: '1' });
    const destination = source.pathname === '/onboarding' ? source.searchParams.get('return_to') : returnPath;
    if (destination) query.set('return_to', safeDashboardReturnPath(destination));
    return '/onboarding?' + query;
  }
  return '/dashboard/accounts?' + new URLSearchParams({ selection_id: selectionId });
}

export function accountSelectionSavedPath(returnPath: string, provider: string): string {
  const destination = new URL(safeReturnPath(returnPath), 'https://adport.invalid');
  destination.searchParams.delete('selection_id');
  destination.searchParams.delete('connected');
  destination.searchParams.set('accounts_saved', provider);
  return `${destination.pathname}${destination.search}${destination.hash}`;
}
