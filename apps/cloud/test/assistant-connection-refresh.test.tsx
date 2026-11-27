// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssistantConnections, type OAuthGrantSummary } from '@/app/dashboard/agents/assistant-connections';

const time = Date.parse('2026-11-27T09:00:00Z');
const grant: OAuthGrantSummary = {
  clientId: 'client', userId: 'owner', clientName: 'Codex', clientUri: null, scopes: ['tools:read'],
  resource: 'https://app.adport.test/mcp', createdAt: new Date(time).toISOString(), expiresAt: new Date(time + 86400000).toISOString(),
  lastUsedAt: null, status: 'active',
};
const active = { ...grant, lastUsedAt: grant.createdAt };
const showConnections = () => render(<AssistantConnections organizationId="project" currentUserId="owner" initialGrants={[grant]} initialCheckedAt={time} />);
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(time); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('refreshes a waiting connection only while visible and stops after it is used', async () => {
  const fetch = vi.fn().mockImplementation(async () => Response.json({ oauthGrants: [active] }));
  vi.stubGlobal('fetch', fetch);
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  showConnections();
  expect(screen.getByText('Waiting for first read')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Refresh status' })).toBeNull();
  await tick(20_000);
  expect(fetch).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  await tick(10_000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith('/api/api-keys?organization_id=project&view=connections', expect.objectContaining({ cache: 'no-store' }));
  expect(screen.getByText('In use')).toBeTruthy();
  await tick(30_000);
  expect(fetch).toHaveBeenCalledOnce();
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not overlap requests when a connection check is slow', async () => {
  let respond!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; }));
  vi.stubGlobal('fetch', fetch);
  showConnections();
  await tick(30_000);
  expect(fetch).toHaveBeenCalledOnce();
  expect((fetch.mock.calls as unknown as [string, RequestInit][])[0]?.[1].signal?.aborted).toBe(false);
  await act(async () => { respond(Response.json({ oauthGrants: [active] })); });
  expect(screen.getByText('In use')).toBeTruthy();
});

it('keeps the last status and offers Retry only after a failed check', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ error: 'Status could not be checked.' }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ oauthGrants: [active] }));
  vi.stubGlobal('fetch', fetch);
  showConnections();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  await tick(10_000);
  expect(screen.getByRole('alert').textContent).toBe('Status could not be checked.');
  expect(screen.getByText('Waiting for first read')).toBeTruthy();
  await tick(20_000);
  expect(fetch).toHaveBeenCalledOnce();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  expect(screen.getByText('In use')).toBeTruthy();
});
