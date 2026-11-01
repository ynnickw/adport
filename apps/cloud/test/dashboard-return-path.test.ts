import { describe, expect, it } from 'vitest';
import { safeDashboardReturnPath, safeReturnPath } from '@/lib/return-path';

describe('dashboard return destinations', () => {
  it('preserves the chosen plan and billing interval', () => {
    expect(safeDashboardReturnPath('/dashboard/billing?plan=premium&billing=annual')).toBe('/dashboard/billing?plan=premium&billing=annual');
    expect(safeReturnPath('/account-selection?selection_id=fixture')).toBe('/account-selection?selection_id=fixture');
  });

  it.each(['https://other.example/dashboard', '//other.example/dashboard', '/onboarding', '/login', '/dashboard-elsewhere', null])('prevents external destinations and onboarding loops from %s', value => {
    expect(safeDashboardReturnPath(value)).toBe('/dashboard');
  });
});
