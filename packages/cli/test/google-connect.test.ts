import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '@adport/core';
import { GoogleAdsRestClient } from '@adport/provider-google';
import { connectGoogle } from '../src/connect/google.js';

const mocks = vi.hoisted(() => ({ question: vi.fn(), exchange: vi.fn(), authUrl: vi.fn(() => 'https://accounts.google.com/test') }));
vi.mock('node:readline/promises', () => ({ default: { createInterface: () => ({ question: mocks.question, close: vi.fn() }) } }));
vi.mock('../src/connect/oauth.js', () => ({
  generateOAuthState: () => 'state', generatePkce: () => ({ challenge: 'challenge', verifier: 'verifier' }),
  buildGoogleAuthUrl: mocks.authUrl, openInBrowser: vi.fn(),
  startLoopbackServer: async () => ({ redirectUri: 'http://127.0.0.1:12345', waitForCode: Promise.resolve('code'), close: vi.fn() }),
  exchangeCodeForTokens: mocks.exchange,
}));

let dir: string;
const io = { out: vi.fn(), err: vi.fn() };
beforeEach(async () => {
  vi.clearAllMocks();
  dir = await mkdtemp(path.join(tmpdir(), 'adport-google-connect-'));
  vi.stubEnv('ADPORT_HOME', dir);
  vi.stubEnv('GOOGLE_ADS_CONFIGURATION_FILE_PATH', path.join(dir, 'google-ads.yaml'));
  mocks.question.mockReset().mockResolvedValue('');
  mocks.exchange.mockResolvedValue({ refreshToken: 'new-refresh' });
  vi.spyOn(GoogleAdsRestClient.prototype, 'listAccessibleCustomers').mockResolvedValue(['1234567890']);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true }); });

describe('Google tokenless connection', () => {
  it.each<Record<string, string>>([{}, { developer_token: 'legacy' }])('reauthorizes stored OAuth credentials: %j', async legacy => {
    await new CredentialStore().set({ provider: 'google', source: 'byo', data: {
      client_id: 'client', client_secret: 'secret', refresh_token: 'old-refresh', ...legacy,
    } });
    await connectGoogle({ openBrowser: false, io });
    expect(mocks.exchange).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'client', clientSecret: 'secret' }));
    const saved = (await new CredentialStore().get('google'))!.data;
    expect(saved.refresh_token).toBe('new-refresh');
    expect(saved.developer_token).toBeUndefined();
    expect(mocks.question).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'developer_token: legacy\n'])('imports YAML without requiring or retaining a token (%s)', async legacy => {
    await writeFile(path.join(dir, 'google-ads.yaml'), `${legacy}client_id: client\nclient_secret: secret\nrefresh_token: imported-refresh\n`);
    await connectGoogle({ openBrowser: false, io });
    expect((await new CredentialStore().get('google'))!.data).toEqual({ client_id: 'client', client_secret: 'secret', refresh_token: 'imported-refresh' });
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.question).toHaveBeenCalledTimes(1);
  });

  it('requests Data Manager only with explicit opt-in and verifies that grant before storing it', async () => {
    await new CredentialStore().set({ provider: 'google', source: 'byo', data: { client_id: 'client', client_secret: 'secret', refresh_token: 'old-refresh' } });
    vi.spyOn(GoogleAdsRestClient.prototype, 'dataManagerAccess').mockResolvedValue({ required_scope: 'https://www.googleapis.com/auth/datamanager', scope_status: 'GRANTED' });
    await connectGoogle({ openBrowser: false, dataManager: true, io });
    expect(mocks.authUrl).toHaveBeenCalledWith('client', 'http://127.0.0.1:12345', 'challenge', 'state', true);
    expect((await new CredentialStore().get('google'))!.data.refresh_token).toBe('new-refresh');
    expect(io.out.mock.calls.flat().join(' ')).toContain('Data Manager is explicitly requested');
  });

  it('does not replace the previous connection when the requested scope is not granted', async () => {
    const previous = { client_id: 'client', client_secret: 'secret', refresh_token: 'old-refresh' };
    await new CredentialStore().set({ provider: 'google', source: 'byo', data: previous });
    vi.spyOn(GoogleAdsRestClient.prototype, 'dataManagerAccess').mockResolvedValue({ required_scope: 'https://www.googleapis.com/auth/datamanager', scope_status: 'MISSING' });
    await expect(connectGoogle({ openBrowser: false, dataManager: true, io })).rejects.toThrow('previous stored connection has been preserved');
    expect((await new CredentialStore().get('google'))!.data).toEqual(previous);
  });

  it('reauthorizes an imported YAML token only when Data Manager was explicitly requested', async () => {
    await writeFile(path.join(dir, 'google-ads.yaml'), 'client_id: client\nclient_secret: secret\nrefresh_token: imported-refresh\n');
    vi.spyOn(GoogleAdsRestClient.prototype, 'dataManagerAccess').mockResolvedValueOnce({ required_scope: 'https://www.googleapis.com/auth/datamanager', scope_status: 'MISSING' }).mockResolvedValueOnce({ required_scope: 'https://www.googleapis.com/auth/datamanager', scope_status: 'GRANTED' });
    await connectGoogle({ openBrowser: false, dataManager: true, io });
    expect(mocks.authUrl).toHaveBeenCalledWith('client', 'http://127.0.0.1:12345', 'challenge', 'state', true);
    expect((await new CredentialStore().get('google'))!.data.refresh_token).toBe('new-refresh');
  });
});
