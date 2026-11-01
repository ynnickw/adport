import { describe, expect, it } from 'vitest';
import { billingStatus } from '@/lib/billing-status';
const active = { status: 'active' as const, cancelAtPeriodEnd: false, currentPeriodEnd: new Date('2026-12-01T00:00:00Z') };
describe('billing lifecycle messages', () => {
  it('shows the paid access end date for scheduled cancellations', () => {
    expect(billingStatus({ ...active, cancelAtPeriodEnd: true })).toMatchObject({ label: 'Cancellation scheduled', message: expect.stringContaining('Dec 1, 2026') });
    expect(billingStatus({ ...active, cancelAt: new Date('2026-11-15T12:00:00Z') }).message).toContain('Nov 15, 2026');
  });
  it('explains cancellation caused by nonpayment without claiming a voluntary cancellation', () => {
    expect(billingStatus({ ...active, status: 'canceled', cancellationReason: 'payment_failed' })).toMatchObject({ label: 'Free access', message: expect.stringContaining('payment attempts failed') });
  });
  it('distinguishes paid payment retry from states without paid access', () => {
    expect(billingStatus({ ...active, status: 'past_due' }).message).toContain('still active');
    expect(billingStatus({ ...active, status: 'past_due', cancelAtPeriodEnd: true }).label).toBe('Payment overdue');
    expect(billingStatus({ ...active, status: 'unpaid' }).message).toContain('unavailable');
    expect(billingStatus({ ...active, status: 'paused' }).message).toContain('read only');
    expect(billingStatus({ ...active, status: 'incomplete_expired' }).label).toBe('Free access');
  });
});
