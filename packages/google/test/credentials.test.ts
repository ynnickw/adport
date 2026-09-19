import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialStore } from '@adport/core';
import { resolveGoogleCredentials } from '../src/index.js';

const oauth = { client_id: 'client', client_secret: 'secret', refresh_token: 'refresh', login_customer_id: '1234567890' };
const store = (data?: Record<string, string>) => ({ get: vi.fn().mockResolvedValue(data ? { data } : undefined) }) as unknown as CredentialStore;

afterEach(() => vi.unstubAllEnvs());

describe('Google project credentials', () => {
  it.each<Record<string, string>>([{}, { developer_token: 'legacy' }])('loads stored OAuth credentials and ignores legacy tokens: %j', async (legacy) => {
    expect(await resolveGoogleCredentials(store({ ...oauth, ...legacy }))).toEqual({
      clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', loginCustomerId: '1234567890',
    });
  });

  it('loads environment credentials without a developer token', async () => {
    vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', '');
    vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'client');
    vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'secret');
    vi.stubEnv('GOOGLE_ADS_REFRESH_TOKEN', 'refresh');
    vi.stubEnv('GOOGLE_ADS_LOGIN_CUSTOMER_ID', '');
    expect(await resolveGoogleCredentials(store())).toEqual({
      clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', loginCustomerId: undefined,
    });
    vi.stubEnv('GOOGLE_ADS_REFRESH_TOKEN', '');
    expect(await resolveGoogleCredentials(store())).toBeUndefined();
  });
});
