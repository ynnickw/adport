import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialStore } from '@adport/core';
import { connectMatomo } from '../src/connect/matomo.js';

afterEach(() => vi.unstubAllEnvs());
describe('adport connect matomo', () => {
  it('imports the environment pair, verifies it with one read and stores the normalized URL', async () => {
    vi.stubEnv('MATOMO_URL', 'https://analytics.example.com/matomo/index.php'); vi.stubEnv('MATOMO_TOKEN_AUTH', 'test-token');
    const fetchImpl = vi.fn().mockResolvedValue(Response.json([{ idsite: 3, name: 'Example', currency: 'EUR', timezone: 'UTC' }]));
    const set = vi.fn(), lines: string[] = [];
    await connectMatomo({ io: { out: line => lines.push(line), err: () => undefined }, fetchImpl: fetchImpl as typeof fetch, store: { set } as unknown as CredentialStore });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://analytics.example.com/matomo/index.php');
    expect(set).toHaveBeenCalledWith({ provider: 'matomo', source: 'byo', data: { url: 'https://analytics.example.com/matomo', token_auth: 'test-token' } });
    expect(lines.join('\n')).toContain('1 Matomo site(s)'); expect(lines.join('\n')).not.toContain('test-token');
  });
  it('stores nothing when the environment pair is incomplete or the token is rejected', async () => {
    const set = vi.fn(), io = { out: () => undefined, err: () => undefined };
    vi.stubEnv('MATOMO_URL', 'https://example.matomo.cloud'); vi.stubEnv('MATOMO_TOKEN_AUTH', '');
    await expect(connectMatomo({ io, store: { set } as unknown as CredentialStore })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    vi.stubEnv('MATOMO_TOKEN_AUTH', 'test-token');
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ result: 'error', message: "You can't access this resource as it requires 'view' access." }));
    await expect(connectMatomo({ io, fetchImpl: fetchImpl as typeof fetch, store: { set } as unknown as CredentialStore })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    vi.stubEnv('MATOMO_URL', 'http://analytics.example.com');
    await expect(connectMatomo({ io, store: { set } as unknown as CredentialStore })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(set).not.toHaveBeenCalled();
  });
});
