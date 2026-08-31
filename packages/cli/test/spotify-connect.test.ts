import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '@adport/core';
import { SpotifyAdsProvider } from '@adport/provider-spotify';
import { connectSpotify } from '../src/connect/spotify.js';

const mocks = vi.hoisted(() => ({ question: vi.fn(), closePrompt: vi.fn(), closeServer: vi.fn(), startServer: vi.fn(), openBrowser: vi.fn(), exchange: vi.fn() }));
vi.mock('node:readline/promises', () => ({ default: { createInterface: () => ({ question: mocks.question, close: mocks.closePrompt }) } }));
vi.mock('../src/connect/oauth.js', () => ({ generateOAuthState: () => 'state-fixture', startLoopbackServer: mocks.startServer, openInBrowser: mocks.openBrowser }));
vi.mock('@adport/provider-spotify', async importOriginal => ({ ...await importOriginal<typeof import('@adport/provider-spotify')>(), exchangeSpotifyCode: mocks.exchange }));
let dir: string;
let lines: string[];
const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
beforeEach(async () => {
  vi.clearAllMocks();
  dir = await mkdtemp(path.join(tmpdir(), 'adport-spotify-connect-'));
  vi.stubEnv('ADPORT_HOME', dir);
  vi.stubEnv('SPOTIFY_CLIENT_ID', '');
  vi.stubEnv('SPOTIFY_CLIENT_SECRET', 'synthetic-secret');
  vi.stubEnv('SPOTIFY_REFRESH_TOKEN', '');
  mocks.question.mockReset().mockResolvedValueOnce('synthetic-client').mockResolvedValueOnce('');
  mocks.startServer.mockReset().mockResolvedValue({ waitForCode: Promise.resolve('synthetic-code'), close: mocks.closeServer });
  mocks.exchange.mockReset().mockResolvedValue('synthetic-refresh');
  vi.spyOn(SpotifyAdsProvider.prototype, 'listAccounts').mockResolvedValue([{ provider: 'spotify', id: '7f4c1cc9-9a1d-4b65-b05c-46e5e33b6705', name: 'Test account', currency: 'EUR' }]);
  lines = [];
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true }); });

describe('Spotify local connect wizard', () => {
  it('verifies accounts before storing, binds loopback with state, and never prints secrets', async () => {
    await connectSpotify({ openBrowser: true, io });
    expect(mocks.startServer).toHaveBeenCalledWith('127.0.0.1', 'state-fixture', 53685, '/callback');
    expect(mocks.exchange).toHaveBeenCalledWith({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', code: 'synthetic-code', redirectUri: 'http://127.0.0.1:53685/callback' });
    const authUrl = new URL(mocks.openBrowser.mock.calls[0]![0]);
    expect(authUrl.searchParams.get('state')).toBe('state-fixture');
    expect((await new CredentialStore().get('spotify'))?.data).toMatchObject({ refresh_token: 'synthetic-refresh', redirect_uri: 'http://127.0.0.1:53685/callback' });
    expect((await stat(path.join(dir, 'credentials.json'))).mode & 0o777).toBe(0o600);
    expect(lines.join('\n')).not.toMatch(/synthetic-secret|synthetic-refresh|synthetic-code/);
    expect(lines.join('\n')).toContain('Adport Cloud and its hosted OAuth broker are not used');
    expect(mocks.closeServer).toHaveBeenCalledOnce();
    expect(mocks.closePrompt).toHaveBeenCalledOnce();
  });
  it('honors --no-browser and a custom registered loopback port/path', async () => {
    mocks.question.mockReset().mockResolvedValueOnce('client').mockResolvedValueOnce('http://127.0.0.1:53699/spotify');
    await connectSpotify({ openBrowser: false, io });
    expect(mocks.openBrowser).not.toHaveBeenCalled();
    expect(mocks.startServer).toHaveBeenCalledWith('127.0.0.1', 'state-fixture', 53699, '/spotify');
    expect(mocks.exchange).toHaveBeenCalledWith(expect.objectContaining({ redirectUri: 'http://127.0.0.1:53699/spotify' }));
  });
  it('reuses stored credentials without requesting an echoed secret', async () => {
    vi.stubEnv('SPOTIFY_CLIENT_SECRET', '');
    await new CredentialStore().set({ provider: 'spotify', source: 'byo', data: { client_id: 'stored-id', client_secret: 'stored-secret', refresh_token: 'old-refresh' } });
    mocks.question.mockReset().mockResolvedValue('');
    await connectSpotify({ openBrowser: false, io });
    expect(mocks.exchange).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'stored-id', clientSecret: 'stored-secret' }));
    expect(mocks.question.mock.calls.every(([prompt]) => !String(prompt).includes('secret'))).toBe(true);
  });
  it.each(['https://app.adport.dev/callback', 'http://evil.example:53685/callback', 'http://localhost:53685/callback', 'http://127.0.0.1:53685/callback?extra=1'])('rejects non-local or unmatchable callback %s', async callback => {
    mocks.question.mockReset().mockResolvedValueOnce('client').mockResolvedValueOnce(callback);
    await expect(connectSpotify({ openBrowser: false, io })).rejects.toThrow('loopback callback');
    expect(mocks.startServer).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it('does not overwrite a working connection if the fresh grant fails verification', async () => {
    const store = new CredentialStore();
    await store.set({ provider: 'spotify', source: 'byo', data: { client_id: 'old-id', client_secret: 'old-secret', refresh_token: 'working-refresh' } });
    vi.mocked(SpotifyAdsProvider.prototype.listAccounts).mockRejectedValue(new Error('403 allowlisting'));
    await expect(connectSpotify({ openBrowser: false, io })).rejects.toThrow('403');
    expect((await store.get('spotify'))?.data.refresh_token).toBe('working-refresh');
    expect(mocks.closeServer).toHaveBeenCalledOnce();
  });
  it('closes the listener after a failed exchange without persisting credentials', async () => {
    mocks.exchange.mockRejectedValue(new Error('OAuth failed'));
    await expect(connectSpotify({ openBrowser: false, io })).rejects.toThrow('OAuth failed');
    expect(mocks.closeServer).toHaveBeenCalledOnce();
    expect(await new CredentialStore().get('spotify')).toBeUndefined();
  });
  it('rejects missing client secret before starting authorization', async () => {
    vi.stubEnv('SPOTIFY_CLIENT_SECRET', '');
    await expect(connectSpotify({ openBrowser: false, io })).rejects.toThrow('SPOTIFY_CLIENT_SECRET');
    expect(mocks.startServer).not.toHaveBeenCalled();
  });
});
