import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '@adport/core';
import { LinkedInAdsProvider } from '@adport/provider-linkedin';
import { connectLinkedIn } from '../src/connect/linkedin.js';

let dir: string, lines: string[];
const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'adport-linkedin-connect-'));
  vi.stubEnv('ADPORT_HOME', dir);
  for (const field of ['ACCESS_TOKEN', 'REFRESH_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'EXPIRES_AT', 'REFRESH_EXPIRES_AT']) vi.stubEnv(`LINKEDIN_${field}`, '');
  vi.stubEnv('LINKEDIN_ACCESS_TOKEN', 'synthetic-token');
  vi.spyOn(LinkedInAdsProvider.prototype, 'listAccounts').mockResolvedValue([{ provider: 'linkedin', id: '518121035', name: 'Test account', currency: 'EUR' }]);
  lines = [];
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true }); });

describe('LinkedIn local token onboarding', () => {
  it('verifies before saving access-only credentials with 0600 permissions and no secret output', async () => {
    await connectLinkedIn({ openBrowser: false, io });
    expect((await new CredentialStore().get('linkedin'))!.data).toEqual({ access_token: 'synthetic-token' });
    expect((await stat(path.join(dir, 'credentials.json'))).mode & 0o777).toBe(0o600);
    expect(lines.join('\n')).not.toContain('synthetic-token');
    expect(lines.join('\n')).toContain('cannot refresh automatically');
    expect(lines.join('\n')).toContain('Adport Cloud and its hosted OAuth broker are not used');
  });
  it('imports complete optional partner-refresh credentials and absolute expirations', async () => {
    vi.stubEnv('LINKEDIN_REFRESH_TOKEN', 'synthetic-refresh'); vi.stubEnv('LINKEDIN_CLIENT_ID', 'client'); vi.stubEnv('LINKEDIN_CLIENT_SECRET', 'synthetic-secret');
    vi.stubEnv('LINKEDIN_EXPIRES_AT', '1893456000000'); vi.stubEnv('LINKEDIN_REFRESH_EXPIRES_AT', '1903456000000');
    await connectLinkedIn({ openBrowser: false, io });
    expect((await new CredentialStore().get('linkedin'))!.data).toMatchObject({ client_id: 'client', client_secret: 'synthetic-secret', refresh_token: 'synthetic-refresh', expires_at: '1893456000000', refresh_expires_at: '1903456000000' });
    expect(lines.join('\n')).not.toMatch(/synthetic-token|synthetic-secret|synthetic-refresh/);
  });
  it('preserves an existing connection when the fresh token fails verification', async () => {
    const store = new CredentialStore();
    await store.set({ provider: 'linkedin', source: 'byo', data: { access_token: 'working-old-token' } });
    vi.mocked(LinkedInAdsProvider.prototype.listAccounts).mockRejectedValue(new Error('403 approval'));
    await expect(connectLinkedIn({ openBrowser: false, io })).rejects.toThrow('403');
    expect((await store.get('linkedin'))!.data.access_token).toBe('working-old-token');
  });
  it('requires a new environment token rather than silently selecting old stored credentials', async () => {
    vi.stubEnv('LINKEDIN_ACCESS_TOKEN', '');
    await new CredentialStore().set({ provider: 'linkedin', source: 'byo', data: { access_token: 'old' } });
    await expect(connectLinkedIn({ openBrowser: true, io })).rejects.toThrow('LINKEDIN_ACCESS_TOKEN');
    expect(LinkedInAdsProvider.prototype.listAccounts).not.toHaveBeenCalled();
  });
  it('rejects an incomplete refresh grant before verification', async () => {
    vi.stubEnv('LINKEDIN_REFRESH_TOKEN', 'refresh');
    await expect(connectLinkedIn({ openBrowser: false, io })).rejects.toThrow('requires both');
    expect(LinkedInAdsProvider.prototype.listAccounts).not.toHaveBeenCalled();
  });
  it.each(['not-a-timestamp', '-1', '1.5'])('rejects malformed expiry %s', async expiry => {
    vi.stubEnv('LINKEDIN_EXPIRES_AT', expiry);
    await expect(connectLinkedIn({ openBrowser: false, io })).rejects.toThrow('Unix milliseconds');
    expect(LinkedInAdsProvider.prototype.listAccounts).not.toHaveBeenCalled();
  });
});
