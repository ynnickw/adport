// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiveData } from '@/app/dashboard/live-data';
import { ToolCatalogEditor } from '@/components/tool-catalog-editor';
import { ApiKeyManager } from '@/app/dashboard/agents/api-key-manager';

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

it('reveals API key settings through the surrounding Advanced disclosure when following a capability link', async () => {
  window.history.replaceState(null, '', '/dashboard/agents?connection=fixture&kind=key');
  render(<ApiKeyManager organizationId="fixture-project" currentUserId="fixture-user" canManage baseUrl="https://app.adport.test" initialGrants={[]} initialCheckedAt={Date.now()} setup={null} />);
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0]!.resolve(Response.json({ oauthGrants: [], keys: [{ id: 'fixture', name: 'Fixture key', keyPrefix: 'fixture', createdAt: new Date().toISOString(), lastUsedAt: null, toolSelection: { profile: 'standard', providers: ['meta'] } }] })));
  const row = (await screen.findByText('Fixture key')).closest('.row-item') as HTMLElement;
  expect(within(row).getByRole('combobox', { name: 'Tool access: Standard' })).toBeTruthy();
  expect(requests).toHaveLength(1);
});

it('copies the API tool search configuration with a placeholder for the key', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<ApiKeyManager organizationId="fixture-project" canManage baseUrl="https://app.adport.test" initialGrants={[]} initialCheckedAt={Date.now()} setup={null} />);
  fireEvent.click(screen.getByText('Advanced: API keys & custom integrations'));
  fireEvent.click(screen.getByText('Tool search for OpenAI and Claude APIs'));
  fireEvent.click(screen.getByRole('button', { name: 'Copy OpenAI Responses API tool search config' }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy Claude Messages API tool search config' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
  expect(JSON.parse(writeText.mock.calls[0]![0]).tools).toEqual([
    { type: 'tool_search' },
    expect.objectContaining({ type: 'mcp', server_url: 'https://app.adport.test/mcp', authorization: 'YOUR_ADPORT_API_KEY', defer_loading: true }),
  ]);
  expect(JSON.parse(writeText.mock.calls[1]![0])).toMatchObject({
    mcp_servers: [{ name: 'adport', url: 'https://app.adport.test/mcp', authorization_token: 'YOUR_ADPORT_API_KEY' }],
    tools: [
      { type: 'tool_search_tool_bm25_20251119' },
      { type: 'mcp_toolset', mcp_server_name: 'adport', default_config: { defer_loading: true } },
    ],
  });
  await waitFor(() => expect(screen.getAllByText('Copied ✓')).toHaveLength(2));
});
