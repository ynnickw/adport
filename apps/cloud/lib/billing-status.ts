import type { OrganizationEntitlement } from '@/lib/cloud/plans';

export function billingStatus(entitlement: Pick<OrganizationEntitlement, 'status' | 'cancelAtPeriodEnd' | 'currentPeriodEnd' | 'cancelAt' | 'canceledAt' | 'cancellationReason'>) {
  const scheduled = ['active', 'trialing'].includes(entitlement.status) && (entitlement.cancelAtPeriodEnd || entitlement.cancelAt);
  if (scheduled) {
    const end = entitlement.cancelAt ?? entitlement.currentPeriodEnd;
    const date = end ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(end) + ' UTC' : 'the end of this billing period';
    return { label: 'Cancellation scheduled', tone: 'warn', message: `Your plan stays active until ${date}. Resume it in Manage billing before then to keep paid access.` };
  }
  if (entitlement.status === 'canceled' || entitlement.status === 'incomplete_expired') return {
    label: 'Free access', tone: 'neutral', message: entitlement.cancellationReason === 'payment_failed'
      ? 'Your subscription ended after payment attempts failed. Your accounts remain connected with Free, read-only access.'
      : 'Your subscription has ended. Your accounts remain connected with Free, read-only access.',
  };
  if (entitlement.status === 'past_due') return { label: 'Payment overdue', tone: 'warn', message: 'Your plan is still active while Stripe retries payment. Update your payment method in Manage billing to prevent an interruption.' };
  if (entitlement.status === 'unpaid') return { label: 'Payment required', tone: 'warn', message: 'Paid access is unavailable because payment is outstanding. Open Manage billing to review the invoice and update your payment method.' };
  if (entitlement.status === 'incomplete') return { label: 'Payment required', tone: 'warn', message: 'Your subscription needs payment confirmation before paid access can start. Open Manage billing to continue.' };
  if (entitlement.status === 'paused') return { label: 'Subscription paused', tone: 'neutral', message: 'Your subscription is paused and ad tools are read only. Open Manage billing or contact support to resume.' };
  return { label: entitlement.status === 'trialing' ? 'Trial active' : 'Active', tone: '', message: null };
}
