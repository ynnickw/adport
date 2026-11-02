import { describe, expect, it } from 'vitest';
import { safeDashboardReturnPath, safeProjectSwitchReturnPath, safeReturnPath } from '@/lib/return-path';

describe('dashboard return destinations', () => {
  it('preserves the chosen plan and billing interval', () => {
    expect(safeDashboardReturnPath('/dashboard/billing?plan=premium&billing=annual')).toBe('/dashboard/billing?plan=premium&billing=annual');
    expect(safeReturnPath('/account-selection?selection_id=fixture')).toBe('/account-selection?selection_id=fixture');
  });

  it.each(['https://other.example/dashboard', '//other.example/dashboard', '/onboarding', '/login', '/dashboard-elsewhere', null])('prevents external destinations and onboarding loops from %s', value => {
    expect(safeDashboardReturnPath(value)).toBe('/dashboard');
  });
});

describe('project switch destinations', () => {
  it('keeps the dashboard page and query when switching', () => {
    expect(safeProjectSwitchReturnPath('/dashboard/projects?filter=active')).toBe('/dashboard/projects?filter=active');
  });

  it('resumes the next project without carrying the previous project’s setup state', () => {
    const path = safeProjectSwitchReturnPath('/onboarding?step=agent&selection_id=previous&connected=google&return_to=%2Fdashboard%2Fconnections');
    const url = new URL(path, 'https://adport.invalid');
    expect(url.pathname).toBe('/onboarding');
    expect([...url.searchParams]).toEqual([['resume', '1'], ['return_to', '/dashboard/connections']]);
  });

  it.each(['https://other.example/onboarding', '//other.example/onboarding', '/dashboard/\\other.example', '/login', null])('rejects unsafe destinations: %s', value => {
    expect(safeProjectSwitchReturnPath(value)).toBe('/dashboard');
  });

  it('sanitizes a nested setup return path', () => {
    expect(safeProjectSwitchReturnPath('/onboarding?return_to=https%3A%2F%2Fother.example')).toBe('/onboarding?resume=1&return_to=%2Fdashboard');
  });
});
