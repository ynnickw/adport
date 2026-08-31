import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '@adport/core';
import { SnapchatAdsProvider } from '@adport/provider-snapchat';
import { connectSnapchat } from '../src/connect/snapchat.js';

const mocks = vi.hoisted(() => ({ question: vi.fn(), closePrompt: vi.fn(), closeServer: vi.fn(), startServer: vi.fn(), openBrowser: vi.fn(), exchange: vi.fn() }));
vi.mock('node:readline/promises', () => ({ default: { createInterface: () => ({ question: mocks.question, close: mocks.closePrompt }) } }));
vi.mock('../src/connect/oauth.js', () => ({ generateOAuthState: () => 'state-fixture', startLoopbackServer: mocks.startServer, openInBrowser: mocks.openBrowser }));
vi.mock('@adport/provider-snapchat', async importOriginal => ({ ...await importOriginal<typeof import('@adport/provider-snapchat')>(), exchangeSnapchatCode: mocks.exchange }));
let directory: string, lines: string[];
const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), 'adport-snapchat-connect-'));
  vi.stubEnv('ADPORT_HOME', directory); vi.stubEnv('SNAPCHAT_CLIENT_ID', ''); vi.stubEnv('SNAPCHAT_CLIENT_SECRET', 'synthetic-secret');
  mocks.question.mockReset().mockResolvedValueOnce('synthetic-client').mockResolvedValueOnce('');
  mocks.startServer.mockReset().mockResolvedValue({ waitForCode: Promise.resolve('synthetic-code'), close: mocks.closeServer });
  mocks.exchange.mockReset().mockResolvedValue('synthetic-refresh');
  vi.spyOn(SnapchatAdsProvider.prototype, 'listAccounts').mockResolvedValue([{ provider: 'snapchat', id: '79d42cf9-b74d-4b0b-b8a5-28eb564da739', name: 'Test account', currency: 'EUR' }]);
  lines = [];
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true }); });

describe('Snapchat local onboarding', () => {
  it('binds state to loopback and stores a verified grant with mode 0600', async () => {
    await connectSnapchat({ openBrowser: true, io });
    expect(mocks.startServer).toHaveBeenCalledWith('127.0.0.1', 'state-fixture', 53684, '/callback');
    expect(mocks.exchange).toHaveBeenCalledWith({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', code: 'synthetic-code', redirectUri: 'http://127.0.0.1:53684/callback' });
    const url = new URL(mocks.openBrowser.mock.calls[0]![0]);
    expect(url.searchParams.get('state')).toBe('state-fixture');
    expect(url.searchParams.get('scope')).toBe('snapchat-marketing-api');
    expect((await new CredentialStore().get('snapchat'))?.data.refresh_token).toBe('synthetic-refresh');
    expect((await stat(path.join(directory, 'credentials.json'))).mode & 0o777).toBe(0o600);
    expect(lines.join('\n')).not.toMatch(/synthetic-secret|synthetic-code|synthetic-refresh/);
    expect(lines.join('\n')).toContain('Adport Cloud and its hosted OAuth broker are not used');
    expect(mocks.closeServer).toHaveBeenCalledOnce(); expect(mocks.closePrompt).toHaveBeenCalledOnce();
  });

  it('reuses the matching stored app and custom callback without opening a browser', async () => {
    await new CredentialStore().set({ provider: 'snapchat', source: 'byo', data: { client_id: 'stored-client', client_secret: 'stored-secret', refresh_token: 'old', redirect_uri: 'http://localhost:53698/snap' } });
    vi.stubEnv('SNAPCHAT_CLIENT_SECRET', ''); mocks.question.mockReset().mockResolvedValue('');
    await connectSnapchat({ openBrowser: false, io });
    expect(mocks.startServer).toHaveBeenCalledWith('localhost', 'state-fixture', 53698, '/snap');
    expect(mocks.exchange).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'stored-client', clientSecret: 'stored-secret' }));
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.question.mock.calls.every(([prompt]) => !String(prompt).toLowerCase().includes('secret'))).toBe(true);
  });

  it('does not pair a new client id with a different stored app secret', async () => {
    await new CredentialStore().set({ provider: 'snapchat', source: 'byo', data: { client_id: 'stored-client', client_secret: 'stored-secret', refresh_token: 'old' } });
    vi.stubEnv('SNAPCHAT_CLIENT_SECRET', '');
    await expect(connectSnapchat({ openBrowser: false, io })).rejects.toThrow(/SNAPCHAT_CLIENT_SECRET/);
    expect(mocks.startServer).not.toHaveBeenCalled();
  });

  it('uses an explicitly supplied environment app pair instead of mixing with the saved app', async () => {
    await new CredentialStore().set({ provider: 'snapchat', source: 'byo', data: { client_id: 'stored-client', client_secret: 'stored-secret', refresh_token: 'old' } });
    vi.stubEnv('SNAPCHAT_CLIENT_ID', 'environment-client'); mocks.question.mockReset().mockResolvedValue('');
    await connectSnapchat({ openBrowser: false, io });
    expect(mocks.exchange).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'environment-client', clientSecret: 'synthetic-secret' }));
  });

  it.each(['https://app.adport.dev/callback', 'http://external.test:53684/callback', 'http://127.0.0.1/callback', 'http://127.0.0.1:53684/callback?state=bad', 'http://user:pass@localhost:53684/callback', 'http://localhost:53684/callback#fragment'])('rejects an unsafe callback %s', async callback => {
    mocks.question.mockReset().mockResolvedValueOnce('client').mockResolvedValueOnce(callback);
    await expect(connectSnapchat({ openBrowser: false, io })).rejects.toThrow(/loopback callback/);
    expect(mocks.startServer).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it('retains the previous working grant if account discovery fails', async () => {
    const store = new CredentialStore();
    await store.set({ provider: 'snapchat', source: 'byo', data: { client_id: 'old-client', client_secret: 'old-secret', refresh_token: 'working' } });
    vi.mocked(SnapchatAdsProvider.prototype.listAccounts).mockRejectedValue(new Error('403 permission denied'));
    await expect(connectSnapchat({ openBrowser: false, io })).rejects.toThrow(/403/);
    expect((await store.get('snapchat'))?.data.refresh_token).toBe('working');
    expect(mocks.closeServer).toHaveBeenCalledOnce();
  });

  it('closes the loopback server after an exchange failure', async () => {
    mocks.exchange.mockRejectedValue(new Error('OAuth failed'));
    await expect(connectSnapchat({ openBrowser: false, io })).rejects.toThrow(/OAuth failed/);
    expect(mocks.closeServer).toHaveBeenCalledOnce(); expect(mocks.closePrompt).toHaveBeenCalledOnce();
    expect(await new CredentialStore().get('snapchat')).toBeUndefined();
  });
});
