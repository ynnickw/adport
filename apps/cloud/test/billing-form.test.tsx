// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
vi.mock('@/components/dialog', () => ({ Dialog: ({ title, children }: { title: string; children: ReactNode }) => <section role="dialog" aria-label={title}>{children}</section> }));
import { BillingForm } from '@/app/dashboard/billing/billing-form';
afterEach(cleanup);
it('requires explicit confirmation before ending complimentary access and lets the owner cancel', async () => {
  const action = vi.fn().mockResolvedValue({});
  render(<BillingForm action={action} label="Switch to Free" pendingLabel="Switching…" className="button" confirmation={{ title: 'Switch to Free?', description: 'Your complimentary access will end.', confirmLabel: 'Confirm Free' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Free' }));
  expect(await screen.findByRole('dialog', { name: 'Switch to Free?' })).toBeTruthy();
  expect(action).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(action).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Free' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm Free' }));
  await waitFor(() => expect(action).toHaveBeenCalledOnce());
});
