import { describe, expect, it } from 'vitest';
import { accountSelectionPath, accountSelectionSavedPath } from '@/lib/account-selection-path';

describe('integrated account selection routing', () => {
  it('keeps dashboard account selection in the Accounts layout', () => {
    expect(accountSelectionPath('selection', '/dashboard/connections')).toBe('/dashboard/accounts?selection_id=selection');
  });
  it('preserves the onboarding destination and allows a skipped setup to resume', () => {
    const url = new URL(accountSelectionPath('selection', '/onboarding?return_to=%2Fdashboard%2Fagents&step=connect'), 'https://adport.test');
    expect(url.pathname).toBe('/onboarding');
    expect(url.searchParams.get('return_to')).toBe('/dashboard/agents');
    expect(url.searchParams.get('resume')).toBe('1');
    expect(url.searchParams.get('step')).toBeNull();
  });
  it('lets first-time users select before completing setup', () => {
    const url = new URL(accountSelectionPath('selection', '/dashboard/accounts?select_provider=google', true), 'https://adport.test');
    expect(url.pathname).toBe('/onboarding');
    expect(url.searchParams.get('return_to')).toBe('/dashboard/accounts?select_provider=google');
  });
  it.each(['https://evil.test/path', '//evil.test/path', '/\\evil.test/path'])('rejects an external destination: %s', path => {
    expect(accountSelectionPath('selection', path)).toBe('/dashboard/accounts?selection_id=selection');
    expect(accountSelectionSavedPath(path, 'google')).toBe('/dashboard?accounts_saved=google');
  });
  it('drops the consumed selection and connection flags without losing the setup context', () => {
    const url = new URL(accountSelectionSavedPath('/onboarding?selection_id=old&connected=google&resume=1&return_to=%2Fdashboard%2Fagents', 'google'), 'https://adport.test');
    expect(url.searchParams.get('selection_id')).toBeNull();
    expect(url.searchParams.get('connected')).toBeNull();
    expect(url.searchParams.get('accounts_saved')).toBe('google');
    expect(url.searchParams.get('resume')).toBe('1');
    expect(url.searchParams.get('return_to')).toBe('/dashboard/agents');
  });
});
