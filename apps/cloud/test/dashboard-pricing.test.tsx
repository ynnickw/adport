// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DashboardPricing } from '@/components/dashboard-pricing';
import { BillingForm } from '@/app/dashboard/billing/billing-form';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('switches prices and the matching plan action in place, preserving the upgrade URL context', async () => {
  window.history.replaceState(null, '', '/dashboard/billing');
  const replace = vi.spyOn(window.history, 'replaceState');
  const monthly = vi.fn().mockResolvedValue({}), annual = vi.fn().mockResolvedValue({});
  const links = {
    monthly: '/dashboard/billing?billing=monthly&projectId=project&intent=members&plan=operator',
    annual: '/dashboard/billing?billing=annual&projectId=project&intent=members&plan=operator',
  };
  const { container } = render(<DashboardPricing currentPlanId="premium" initialInterval="monthly" billingLinks={links} canManageBilling
    actions={{ monthly: { operator: <BillingForm action={monthly} label="Choose Pro" pendingLabel="Opening…" className="pricing-action" /> }, annual: { operator: <BillingForm action={annual} label="Choose Pro" pendingLabel="Opening…" className="pricing-action" /> } }}
    notes={{ monthly: {}, annual: {} }} freeAction={<button>Switch to Free</button>} />);
  const pro = within(screen.getByRole('article', { name: 'Pro plan' }));
  expect(pro.getByText('€19')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Yearly Save 2 months' }));
  expect(pro.getByText('€15.83')).toBeTruthy();
  expect(pro.getByText('€190 billed yearly')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Yearly Save 2 months' }).getAttribute('aria-pressed')).toBe('true');
  expect(window.location.search).toBe(links.annual.slice(links.annual.indexOf('?')));
  expect(replace).toHaveBeenLastCalledWith(null, '', links.annual);
  fireEvent.click(pro.getByRole('button', { name: 'Choose Pro' }));
  await waitFor(() => expect(annual).toHaveBeenCalledOnce()); expect(monthly).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /^Monthly$/ }));
  expect(pro.getByText('€19')).toBeTruthy();
  fireEvent.click(pro.getByRole('button', { name: 'Choose Pro' }));
  await waitFor(() => expect(monthly).toHaveBeenCalledOnce());
  expect(container.querySelector('.pricing-free .pricing-trial-note')).toBeNull();
});
