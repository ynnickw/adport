import { describe, expect, it } from 'vitest';
import { accountStatusPresentation } from '@/lib/cloud/account-status';

describe('accountStatusPresentation', () => {
  it('renders provider sentinel values as unavailable and neutral', () => {
    expect(accountStatusPresentation('UNKNOWN')).toEqual({ label: 'Status unavailable', tone: 'neutral' });
    expect(accountStatusPresentation('UNSPECIFIED (manager)')).toEqual({ label: 'Status unavailable (manager)', tone: 'neutral' });
  });

  it('preserves actionable provider statuses', () => {
    expect(accountStatusPresentation('ENABLED')).toEqual({ label: 'ENABLED', tone: '' });
    expect(accountStatusPresentation('PAUSED')).toEqual({ label: 'PAUSED', tone: 'neutral' });
  });

  it('keeps the accessible-account fallback when no status is returned', () => {
    expect(accountStatusPresentation()).toEqual({ label: 'Available', tone: '' });
  });
});
