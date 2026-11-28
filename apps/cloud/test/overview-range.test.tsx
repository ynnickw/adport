// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiveData } from '@/app/dashboard/live-data';
import { ToolCatalogEditor } from '@/components/tool-catalog-editor';
import { ToastProvider } from '@/components/toast';
import { ApiKeyManager } from '@/app/dashboard/agents/api-key-manager';

const requests: Array<{ url: string; init?: RequestInit; resolve: (value: Response) => void }> = [];
beforeEach(() => {
  requests.length = 0;
  window.history.replaceState(null, '', '/dashboard');
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise<Response>(resolve => requests.push({ url, init, resolve }))));
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
  expect(screen.getByRole('link', { name: 'Campaign report' }).getAttribute('href')).toBe('/dashboard/reports?range=yesterday');
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
  render(<ToastProvider><ToolCatalogEditor organizationId="fixture-project" connection={{ type: 'key', id: 'fixture' }} initialSelection={{ profile: 'standard', providers: ['meta'] }} onSaved={vi.fn()} /></ToastProvider>);
  const dialog = screen.getByRole('dialog', { name: 'API key tool access' });
  expect(within(dialog).getByRole('radio', { name: /^Standard/ })).toHaveProperty('checked', true);
  expect(within(dialog).getByRole('button', { name: 'Save tool access' })).toHaveProperty('disabled', true);
  expect(requests).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole('radio', { name: /^Full/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save tool access' }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(JSON.parse(requests[0]!.init!.body as string)).toMatchObject({ selection: { profile: 'full', providers: ['meta'] } });
  await act(async () => requests[0]!.resolve(Response.json({ selection: { profile: 'full', providers: ['meta'] } })));
  expect(await screen.findByText('Tool access saved. Refresh tools in your assistant.')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('reveals API key settings in Developer settings when following a capability link', async () => {
  window.history.replaceState(null, '', '/dashboard/developer?connection=fixture&kind=key');
  render(<ApiKeyManager organizationId="fixture-project" suggestedProviders={[]} baseUrl="https://app.adport.test" />);
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0]!.resolve(Response.json({ oauthGrants: [], keys: [{ id: 'fixture', name: 'Fixture key', keyPrefix: 'fixture', createdAt: new Date().toISOString(), lastUsedAt: null, toolSelection: { profile: 'standard', providers: ['meta'] } }] })));
  const dialog = await screen.findByRole('dialog', { name: 'API key tool access' });
  expect(within(dialog).getByRole('radio', { name: /^Standard/ })).toHaveProperty('checked', true);
  expect(requests).toHaveLength(1);
});

it('previews a Standard migration and limits it to connected platforms when saved', async () => {
  render(<ToastProvider><ToolCatalogEditor organizationId="fixture-project" connection={{ type: 'key', id: 'fixture' }}
    initialSelection={{ profile: 'full', providers: null }} suggestedProviders={['meta']} scopes={['tools:read']}
    catalogCounts={[
      { providers: [], counts: { full: { read: 3, write: 1 }, reporting: { read: 3, write: 0 }, standard: { read: 3, write: 1 } } },
      { providers: ['meta'], counts: { full: { read: 20, write: 10 }, reporting: { read: 20, write: 0 }, standard: { read: 7, write: 4 } } },
      { providers: ['google'], counts: { full: { read: 30, write: 15 }, reporting: { read: 30, write: 0 }, standard: { read: 8, write: 2 } } },
    ]} onSaved={vi.fn()} /></ToastProvider>);
  fireEvent.click(screen.getByRole('button', { name: /^Tool access/ }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByRole('status', { name: 'Estimated tool count' }).textContent).toBe('53 → 10 tools with Standard');
  expect(dialog.getByRole('link', { name: /on-demand tool loading/ }).getAttribute('href')).toBe('/dashboard/developer?toolSearch=1#tool-search');
  fireEvent.click(dialog.getByRole('button', { name: 'Use Standard' }));
  expect(dialog.getByRole('status', { name: 'Estimated tool count' }).textContent).toBe('53 → 10 tools after saving');
  expect(dialog.getByRole('checkbox', { name: 'Meta Ads' })).toHaveProperty('checked', true);
  expect(dialog.getByRole('checkbox', { name: 'Google Ads' })).toHaveProperty('checked', false);
  expect(requests).toHaveLength(0);
  fireEvent.click(dialog.getByRole('button', { name: 'Save tool access' }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(JSON.parse(requests[0]!.init!.body as string)).toMatchObject({ selection: { profile: 'standard', providers: ['meta'] } });
  await act(async () => requests[0]!.resolve(Response.json({ selection: { profile: 'standard', providers: ['meta'] } })));
});

it('keeps unsaved access choices after a failure and discards them only when canceled', async () => {
  render(<ToolCatalogEditor organizationId="fixture-project" name="Claude"
    connection={{ type: 'oauth', client_id: 'client', user_id: 'owner', resource: 'https://app.adport.test/mcp', organization_group_id: null }}
    initialSelection={{ profile: 'reporting', providers: null }} onSaved={vi.fn()} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Manage access for Claude' }));
  const dialog = screen.getByRole('dialog', { name: 'Claude access' });
  expect(within(dialog).queryByRole('checkbox')).toBeNull();
  fireEvent.click(within(dialog).getByRole('radio', { name: 'Choose platforms' }));
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Google Ads' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save tool access' }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(JSON.parse(requests[0]!.init!.body as string)).toMatchObject({ selection: { profile: 'reporting', providers: ['google'] } });
  await act(async () => requests[0]!.resolve(Response.json({ error: 'Try again.' }, { status: 503 })));
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Try again.');
  expect(within(dialog).getByRole('checkbox', { name: 'Google Ads' })).toHaveProperty('checked', true);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Manage access for Claude' }));
  expect(within(screen.getByRole('dialog')).getByRole('radio', { name: 'All platforms' })).toHaveProperty('checked', true);
  expect(requests).toHaveLength(1);
});

it('explains each access tier without changing the current selection', () => {
  render(<ToolCatalogEditor organizationId="fixture-project" name="Claude"
    connection={{ type: 'key', id: 'fixture' }} initialSelection={{ profile: 'standard', providers: null }} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage access for Claude' }));
  const dialog = screen.getByRole('dialog', { name: 'Claude access' });
  for (const [tier, details] of [['Reporting', 'Read-only access'], ['Standard', 'everyday campaign tools'], ['Full', 'advanced tools where supported']]) {
    const icon = within(dialog).getByRole('button', { name: `About ${tier} access` });
    fireEvent.click(icon);
    expect(within(dialog).getByRole('tooltip').textContent).toContain(details);
    expect(icon.getAttribute('aria-describedby')).toBe(within(dialog).getByRole('tooltip').id);
    expect(fireEvent.keyDown(icon, { key: 'Escape' })).toBe(false);
    expect(within(dialog).queryByRole('tooltip')).toBeNull();
  }
  expect(within(dialog).getByRole('radio', { name: /^Standard/ })).toHaveProperty('checked', true);
  expect(within(dialog).getByRole('button', { name: 'Save tool access' })).toHaveProperty('disabled', true);
  expect(requests).toHaveLength(0);
});

it.each([false, true])('creates a read-only key unless changes are explicitly selected (%s)', async write => {
  render(<ApiKeyManager organizationId="fixture-project" suggestedProviders={['google']} baseUrl="https://app.adport.test" />);
  await waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => requests[0]!.resolve(Response.json({ keys: [] })));
  fireEvent.click(screen.getByText('Create API key', { exact: true }));
  expect(screen.getByRole('checkbox', { name: 'Allow changes after approval' })).toHaveProperty('checked', false);
  if (write) fireEvent.click(screen.getByRole('checkbox', { name: 'Allow changes after approval' }));
  fireEvent.click(screen.getByRole('button', { name: /^Create key$/ }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(JSON.parse(requests[1]!.init?.body as string)).toMatchObject({ scopes: write ? ['tools:read', 'tools:write'] : ['tools:read'] });
});

it('copies the API tool search configuration with a placeholder for the key', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<ToastProvider><ApiKeyManager organizationId="fixture-project" suggestedProviders={[]} baseUrl="https://app.adport.test" openToolSearch /></ToastProvider>);
  expect(screen.getByText('Tool search for OpenAI and Claude APIs').closest('details')?.open).toBe(true);
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
  expect(await screen.findByText('Copied to clipboard.')).toBeTruthy();
  expect(screen.getAllByText('Copied to clipboard.')).toHaveLength(1);
});
