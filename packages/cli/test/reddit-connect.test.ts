import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CredentialStore } from '@adport/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ question: vi.fn(), exchange: vi.fn(), accounts: vi.fn() }));
vi.mock('node:readline/promises', () => ({ default: { createInterface: () => ({ question: mocks.question, close: vi.fn() }) } }));
vi.mock('@adport/provider-reddit', () => ({ RedditAdsClient: class {}, RedditAdsProvider: class { listAccounts = mocks.accounts; } }));
vi.mock('../src/connect/oauth.js', async () => ({
  ...await vi.importActual('../src/connect/oauth.js'),
  exchangeRedditCode: mocks.exchange,
  startLoopbackServer: async () => ({ waitForCode: Promise.resolve('code'), close: vi.fn() }),
}));
import { connectReddit } from '../src/connect/reddit.js';

let home: string;
beforeEach(async () => {
  vi.clearAllMocks(); home = await mkdtemp(path.join(tmpdir(), 'adport-reddit-connect-'));
  vi.stubEnv('ADPORT_HOME', home); mocks.question.mockResolvedValue('');
  mocks.exchange.mockResolvedValue({ refreshToken: 'new-grant' }); mocks.accounts.mockResolvedValue([]);
  await new CredentialStore().set({ provider: 'reddit', source: 'byo', data: { client_id: 'client', client_secret: 'secret',
    user_agent: 'test-adport', refresh_token: 'old-grant', scopes: 'adsread,adsedit,adsdatadeletion,adsconversions' } });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true }); });
it('keeps an opted-in conversion grant during a later ordinary CLI reconnect', async () => {
  const messages: string[] = [];
  await connectReddit({ openBrowser: false, io: { out: message => messages.push(message), err: vi.fn() } });
  expect(mocks.exchange).toHaveBeenCalledWith(expect.objectContaining({ conversions: true }));
  expect(messages.some(message => message.includes('scope=adsread%2Cadsedit%2Cadsdatadeletion%2Cadsconversions'))).toBe(true);
  expect((await new CredentialStore().get('reddit'))?.data).toMatchObject({ refresh_token: 'new-grant', scopes: 'adsread,adsedit,adsdatadeletion,adsconversions' });
});
it('keeps stored credentials if the renewed conversion permission is not confirmed', async () => {
  mocks.exchange.mockRejectedValueOnce(new Error('Reddit did not grant adsconversions'));
  await expect(connectReddit({ openBrowser: false, io: { out: vi.fn(), err: vi.fn() } })).rejects.toThrow('adsconversions');
  expect((await new CredentialStore().get('reddit'))?.data.refresh_token).toBe('old-grant');
  expect(mocks.accounts).not.toHaveBeenCalled();
});
