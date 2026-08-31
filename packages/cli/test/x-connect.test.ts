import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '@adport/core';
import { XAdsProvider } from '@adport/provider-x';
import { connectX } from '../src/connect/x.js';

let dir: string, lines: string[];
const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
const fields = ['CONSUMER_KEY', 'CONSUMER_SECRET', 'ACCESS_TOKEN', 'ACCESS_TOKEN_SECRET'];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'adport-x-connect-')); vi.stubEnv('ADPORT_HOME', dir);
  for (const field of fields) vi.stubEnv(`X_${field}`, `synthetic-${field}`);
  vi.spyOn(XAdsProvider.prototype, 'listAccounts').mockResolvedValue([{ provider: 'x', id: 'a1', name: 'Test account' }]); lines = [];
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true }); });
describe('X local onboarding', () => {
  it('verifies then persists all four OAuth credentials privately without printing them', async () => {
    await connectX({ openBrowser: false, io });
    expect((await stat(path.join(dir, 'credentials.json'))).mode & 0o777).toBe(0o600);
    expect((await new CredentialStore().get('x'))!.data.access_token_secret).toBe('synthetic-ACCESS_TOKEN_SECRET');
    expect(lines.join('\n')).not.toContain('synthetic-'); expect(lines.join('\n')).toContain('hosted OAuth broker are not used');
  });
  it.each(fields)('rejects missing %s before provider verification', async field => {
    vi.stubEnv(`X_${field}`, '');
    await expect(connectX({ openBrowser: false, io })).rejects.toThrow('All four');
    expect(XAdsProvider.prototype.listAccounts).not.toHaveBeenCalled();
  });
  it('preserves the previous grant on verification failure', async () => {
    await new CredentialStore().set({ provider: 'x', source: 'byo', data: { access_token: 'old' } });
    vi.mocked(XAdsProvider.prototype.listAccounts).mockRejectedValue(new Error('403 approval'));
    await expect(connectX({ openBrowser: false, io })).rejects.toThrow('403');
    expect((await new CredentialStore().get('x'))!.data.access_token).toBe('old');
  });
});
