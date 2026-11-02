import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { PlanLimitModal } from '@/components/plan-limit-modal';
import { UpgradeProvider } from '@/components/upgrade-context';
import type { BillingOptions } from '@/lib/cloud/billing-options';

const mocks = vi.hoisted(() => ({ checkout: vi.fn(), portal: vi.fn(), forms: vi.fn() }));
vi.mock('@/components/dialog', () => ({ Dialog: ({ title, children, portal }: { title: string; children: ReactNode; portal: boolean }) => <section role="dialog" aria-label={title} data-portal={portal}>{children}</section> }));
vi.mock('@/app/dashboard/billing/actions', () => ({ startProjectSubscriptionForm: mocks.checkout, openProjectBillingPortalForm: mocks.portal }));
vi.mock('@/app/dashboard/billing/billing-form', () => ({ BillingForm: (props: { label: string }) => { mocks.forms(props); return <button>{props.label}</button>; } }));

const options: BillingOptions = { hasSubscription: false, portalAvailable: false, trialEligible: true, available: { operator: { monthly: true, annual: true }, premium: { monthly: true, annual: true }, agency: { monthly: true, annual: true } } };
const limit = { kind: 'active_accounts' as const, currentPlan: 'Free', recommendedPlan: 'premium' as const, message: 'Your selection needs 12 accounts.' };
const render = (canManageBilling = true, billingOptions = options) => renderToStaticMarkup(<UpgradeProvider value={{ planId: 'reader', canManageBilling, projectId: 'project', billingOptions }}><PlanLimitModal limit={limit} onClose={() => {}} /></UpgradeProvider>);

beforeEach(() => vi.clearAllMocks());
describe('full upgrade paywall', () => {
  it('offers every plan, a Free exit, and the complete feature comparison', () => {
    const html = render();
    for (const text of ['Pro plan', 'Growth plan', 'Business plan', '€19', '€39', '€79', 'Continue with Free', 'Compare all features', 'Plan feature comparison', 'Not now']) expect(html).toContain(text);
    expect(html).toContain('data-portal="true"');
    expect(html).not.toContain('View Pro plan');
  });
  it('starts checkout directly for the selected paid plan instead of routing through another pricing page', async () => {
    render();
    for (const [index, id] of ['operator', 'premium', 'agency'].entries()) {
      await mocks.forms.mock.calls[index]![0].action({}, new FormData());
      expect(mocks.checkout).toHaveBeenLastCalledWith('project', id, 'monthly', {}, expect.any(FormData));
    }
    expect(mocks.portal).not.toHaveBeenCalled();
  });
  it('offers owner handoff instead of purchase actions for teammates', () => {
    const html = render(false);
    for (const name of ['Pro', 'Growth', 'Business']) expect(html).toContain(`Ask owner for ${name}`);
    expect(mocks.forms).not.toHaveBeenCalled();
    expect(html).not.toContain('Start 7-day free trial');
  });
  it('routes existing subscriptions to the billing portal without creating a second checkout', async () => {
    render(true, { ...options, hasSubscription: true, portalAvailable: true, trialEligible: false });
    await mocks.forms.mock.calls[0]![0].action({}, new FormData());
    expect(mocks.portal).toHaveBeenCalledOnce();
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('keeps the comparison usable when checkout is not configured', () => {
    const html = render(true, { ...options, available: { operator: { monthly: false, annual: false }, premium: { monthly: false, annual: false }, agency: { monthly: false, annual: false } } });
    expect(html).toContain('Checkout unavailable');
    expect(html).toContain('Continue with Free');
    expect(mocks.forms).not.toHaveBeenCalled();
  });
});
