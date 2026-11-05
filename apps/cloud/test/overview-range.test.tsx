// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiveData } from '@/app/dashboard/live-data';
import { ToolCatalogEditor } from '@/components/tool-catalog-editor';

const requests: Array<{ url: string; resolve: (value: Response) => void }> = [];
beforeEach(() => {
  requests.length = 0;
  window.history.replaceState(null, '', '/dashboard');
  vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>(resolve => requests.push({ url, resolve }))));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function report(name: string, spend: number) {
  return Response.json({ rows: [{ provider: 'meta', accountId: 'fixture', entity: { id: name, name }, currency: 'EUR', metrics: { spend, clicks: 1, conversions: 1, roas: null } }],
    summary: { complete: true, groups: [{ key: 'EUR', currency: 'EUR', accounts: [{ provider: 'meta', account_id: 'fixture' }], metrics: { spend, clicks: 1, conversions: 1, roas: null } }] } });
}

it('applies dates to the report and ignores an older response after changing range again', async () => {
  render(<LiveData organizationId="fixture" connected />);
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0]!.resolve(report('Initial campaign', 7)));
  expect(await screen.findByText('Initial campaign')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Date range: Last 7 days' }));
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply range' }));
  expect(screen.queryByText('Initial campaign')).toBeNull();
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]!.url).toContain('range=today');
  fireEvent.click(screen.getByRole('button', { name: 'Date range: Today' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yesterday' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply range' }));
  await waitFor(() => expect(requests).toHaveLength(3));
  await act(async () => { requests[2]!.resolve(report('Yesterday campaign', 3)); requests[1]!.resolve(report('Stale today campaign', 99)); });
  expect(await screen.findByText('Yesterday campaign')).toBeTruthy();
  expect(screen.queryByText('Stale today campaign')).toBeNull();
  expect(window.location.search).toContain('range=yesterday');
});

it('keeps draft dates local until Apply and leaves the report unchanged on Cancel', async () => {
  render(<LiveData organizationId="fixture" connected />);
  fireEvent.click(screen.getByRole('button', { name: 'Date range: Last 7 days' }));
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-01-31' } });
  expect(requests).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('button', { name: 'Date range: Last 7 days' })).toBeTruthy();
  expect(requests).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Date range: Last 7 days' }));
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-01-31' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply range' }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]!.url).toContain('range=custom&from=2026-01-01&to=2026-01-31');
  expect(window.location.search).toContain('from=2026-01-01');
});

it('opens the linked connection’s settings and saves only after an explicit user action', async () => {
  window.history.replaceState(null, '', '/dashboard/agents?connection=fixture&kind=key#connected-assistants');
  render(<ToolCatalogEditor organizationId="fixture-project" connection={{ type: 'key', id: 'fixture' }} initialSelection={{ profile: 'standard', providers: ['meta'] }} onSaved={vi.fn()} />);
  expect(document.querySelector('details')?.open).toBe(true);
  expect(requests).toHaveLength(0);
  fireEvent.click(screen.getByRole('combobox', { name: 'Tool access: Standard' }));
  fireEvent.click(screen.getByRole('option', { name: 'Full' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save tool access' }));
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0]!.resolve(Response.json({ selection: { profile: 'full', providers: ['meta'] } })));
  expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('Refresh tools'));
});
