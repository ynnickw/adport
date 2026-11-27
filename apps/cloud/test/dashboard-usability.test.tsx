// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { parseCampaignRange } from '@/app/dashboard/reports/range';
import { FindingsTable } from '@/app/dashboard/findings/findings-table';
import { AccountAccessManager } from '@/app/dashboard/accounts/account-access-manager';
import { ApprovalQueue } from '@/app/dashboard/approvals/approval-queue';
import { ToastProvider } from '@/components/toast';
import { PendingAccountSelections } from '@/components/pending-account-selections';
import type { PendingOperationRow } from '@/lib/cloud/repository';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('uses a stable report default and carries supported Overview ranges through', () => {
  expect(parseCampaignRange({})).toEqual({ range: 'last_30_days' });
  expect(parseCampaignRange({ range: 'last_7_days' })).toEqual({ range: 'last_7_days' });
  expect(parseCampaignRange({ range: 'custom', from: '2025-01-02', to: '2025-01-03' })).toEqual({ range: { start: '2025-01-02', end: '2025-01-03' } });
  for (const params of [
    { range: 'all_time' },
    { range: 'custom', from: '2025-02-29', to: '2025-03-01' },
    { range: 'custom', from: '2025-03-02', to: '2025-03-01' },
  ]) expect(parseCampaignRange(params)).toMatchObject({ range: 'last_30_days', warning: expect.stringContaining('isn’t valid') });
});

it('separates unusable grants from working access and does not expose role-gated actions', () => {
  const account = { provider: 'google', currency: 'EUR', status: 'active', enabled: true };
  render(<AccountAccessManager organizationId="project" accounts={[
    { ...account, accountId: 'a', name: 'Ready', connectionStatus: 'connected' },
    { ...account, accountId: 'b', name: 'Expired', connectionStatus: 'revoked' },
  ]} canManage={false} maxActiveAccounts={15} />);
  expect(screen.getByText('Ready')).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: /Access status/ })).toBeNull();
  expect(screen.getByText('Expired')).toBeTruthy();
  expect(screen.getByText('Connection needs attention')).toBeTruthy();
  expect(screen.queryByRole('link', { name: /Reconnect/ })).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();
});

it('announces successful access changes without inserting a row or hiding a save error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({ error: 'Retry this change' }, { status: 500 })));
  render(<ToastProvider><AccountAccessManager organizationId="project" canManage maxActiveAccounts={15}
    accounts={[{ provider: 'gsc', accountId: 'domain', name: 'Example', currency: null, status: 'siteOwner', enabled: false }]} category="analytics" /></ToastProvider>);
  const toggle = screen.getByRole('switch', { name: 'Adport access for Example' });
  fireEvent.click(toggle);
  expect(await within(screen.getByRole('status', { name: 'Notifications' })).findByText('Adport access enabled for Example.')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Analytics account access' })).queryByText(/Adport access enabled/)).toBeNull();
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(within(screen.getByRole('status', { name: 'Notifications' })).getByRole('button', { name: 'Dismiss notification' }));
  expect(screen.queryByText('Adport access enabled for Example.')).toBeNull();
  fireEvent.click(toggle);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Retry this change');
  expect(toggle.getAttribute('aria-checked')).toBe('true');
});

it('opens a pending Search Console site selection directly on Analytics', () => {
  render(<PendingAccountSelections canManage connections={[{ provider: 'gsc', status: 'connected', accountSelectionId: 'fixture-selection' }]} />);
  expect(screen.getByRole('heading', { name: 'Finish adding sources' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Choose sites' }).getAttribute('href')).toBe('/dashboard/analytics?selection_id=fixture-selection');
});

it('shows open findings by severity and distinguishes a cleared queue from an empty audit history', () => {
  const common = { provider: 'google', accountId: 'a', detail: 'Details', recommendation: 'Check tracking', entity: { id: '123', level: 'campaign', name: 'Brand' }, updatedAt: '2025-01-01T00:00:00Z', updatedLabel: 'Jan 1, 2025, 12:00 AM UTC' };
  const resolved = { ...common, id: 'a', title: 'Done', status: 'applied', severity: 'critical' } as const;
  const { rerender } = render(<FindingsTable findings={[
    { ...common, id: 'b', title: 'Notice', status: 'open', severity: 'info' },
    { ...common, id: 'c', title: 'Action needed', status: 'open', severity: 'critical' },
    resolved,
  ]} />);
  expect(within(screen.getAllByRole('row')[1]!).getByText('Action needed')).toBeTruthy();
  expect(screen.queryByText('Done')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Resolved 1' }));
  expect(screen.getByText('Done')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open 2' }));
  rerender(<FindingsTable findings={[resolved]} />);
  expect(screen.getByRole('heading', { name: 'No open findings' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'View all findings' }));
  expect(screen.getByText('Done')).toBeTruthy();
});

it('keeps the soonest active approvals first and never gives the queue an Apply button', () => {
  const now = Date.now();
  function operation(id: string, delay: number): PendingOperationRow {
    return { id, provider: 'google', operationHash: '', operation: { tool: id, accountId: '123' },
      preview: { summary: id, changes: [], coercions: [], budgetDeltas: [], serverValidated: false },
      createdBy: null, createdAt: new Date(now), expiresAt: new Date(now + delay), consumedAt: null };
  }
  render(<ApprovalQueue pending={[operation('Later', 50_000), operation('Expired', -10), operation('Soon', 30_000)]} />);
  expect(screen.queryByRole('heading', { name: 'Expired' })).toBeNull();
  expect(within(screen.getAllByRole('article')[0]!).getByRole('heading', { name: 'Soon' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'View history' }).getAttribute('href')).toBe('/dashboard/audit');
  expect(screen.queryByRole('button', { name: /Apply|Approve/ })).toBeNull();
});
