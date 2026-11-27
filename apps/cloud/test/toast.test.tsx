// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CheckoutStatus } from '@/app/dashboard/billing/checkout-status';
import { Dialog } from '@/components/dialog';
import { SupportWidget } from '@/components/support-widget';
import { ToastProvider, useToast } from '@/components/toast';

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const notifications = () => screen.getByRole('status', { name: 'Notifications' });

function NestedDialogs() {
  const [outerOpen, setOuterOpen] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);
  const toast = useToast();
  return <>
    <button onClick={() => setOuterOpen(true)}>Open settings</button>
    {outerOpen ? <Dialog title="Settings" onClose={() => setOuterOpen(false)}>
      <button onClick={() => setInnerOpen(true)}>Open review</button>
      {innerOpen ? <Dialog title="Review" onClose={() => setInnerOpen(false)} portal>
        <button onClick={() => toast('Saved successfully.')}>Save</button>
      </Dialog> : null}
    </Dialog> : null}
  </>;
}

it('shows a single shared notification in the top dialog, and keeps it when dialogs close', () => {
  render(<ToastProvider><NestedDialogs /></ToastProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open review' }));
  const review = screen.getByRole('dialog', { name: 'Review' });
  fireEvent.click(within(review).getByRole('button', { name: 'Save' }));
  fireEvent.click(within(review).getByRole('button', { name: 'Save' }));
  expect(review.contains(notifications())).toBe(true);
  expect(screen.getAllByText('Saved successfully.')).toHaveLength(1);
  fireEvent.click(within(review).getByRole('button', { name: 'Close Review' }));
  const settings = screen.getByRole('dialog', { name: 'Settings' });
  expect(settings.contains(notifications())).toBe(true);
  fireEvent.click(within(settings).getByRole('button', { name: 'Close Settings' }));
  expect(within(notifications()).getByText('Saved successfully.')).toBeTruthy();
  fireEvent.click(within(notifications()).getByRole('button', { name: 'Dismiss notification' }));
  expect(screen.queryByText('Saved successfully.')).toBeNull();
});

it('keeps checkout recovery visible until the subscription is confirmed', async () => {
  const { rerender } = render(<ToastProvider><CheckoutStatus status="pending" planName="Pro" /></ToastProvider>);
  expect(screen.getByText(/Finalizing your subscription/)).toBeTruthy();
  expect(within(notifications()).queryByText('Your Pro plan is ready.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh plan' }));
  expect(router.refresh).toHaveBeenCalledOnce();
  rerender(<ToastProvider><CheckoutStatus status="ready" planName="Pro" /></ToastProvider>);
  expect(await within(notifications()).findByText('Your Pro plan is ready.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Refresh plan' })).toBeNull();
});

it('uses an informational toast for a canceled checkout', async () => {
  render(<ToastProvider><CheckoutStatus status="canceled" planName="Pro" /></ToastProvider>);
  const notice = await within(notifications()).findByText('Checkout canceled. Your current plan is unchanged.');
  expect(notice.closest('[data-tone]')?.getAttribute('data-tone')).toBe('info');
  expect(screen.queryByRole('button', { name: 'Refresh plan' })).toBeNull();
});

it('keeps support failures next to the form and shows a receipt only after a successful retry', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce(Response.json({ error: 'Unable to save the message.' }, { status: 500 }))
    .mockResolvedValueOnce(Response.json({ notificationDelayed: true }));
  vi.stubGlobal('fetch', request);
  render(<ToastProvider><SupportWidget /></ToastProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Need help? Message Yannick' }));
  const dialog = screen.getByRole('dialog', { name: 'Message Yannick' });
  const message = within(dialog).getByRole('textbox', { name: 'Your message' });
  fireEvent.change(message, { target: { value: 'An isolated support test message.' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send to Yannick' }));
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Unable to save the message.');
  expect(message).toHaveProperty('value', 'An isolated support test message.');
  expect(screen.queryByText('Message saved. Email notification is delayed.')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send to Yannick' }));
  expect(await within(notifications()).findByText('Message saved. Email notification is delayed.')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]?.[0]).toBe('/api/support');
});
