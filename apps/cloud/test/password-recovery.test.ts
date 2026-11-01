import { beforeEach, describe, expect, it, vi } from 'vitest';
import { passwordRecoveryTokens } from '@/lib/password-recovery';

const mocks = vi.hoisted(() => ({ reset: vi.fn(), exchange: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: () => ({ ADPORT_CLOUD_BASE_URL: 'https://app.adport.dev' }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { resetPasswordForEmail: mocks.reset, exchangeCodeForSession: mocks.exchange } }) }));
import { requestPasswordReset } from '@/app/login/forgot-password/actions';
import { GET as callback } from '@/app/auth/callback/route';

describe('password recovery', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.reset.mockResolvedValue({ error: null }); });
  it('carries a chosen plan through the approved auth callback', async () => {
    const form = new FormData(); form.set('email', ' client@example.test '); form.set('return_to', '/dashboard/billing?plan=premium&billing=annual');
    expect(await requestPasswordReset({}, form)).toEqual({ sent: true });
    const [email, options] = mocks.reset.mock.calls[0]!;
    expect(email).toBe('client@example.test');
    const redirect = new URL(options.redirectTo);
    expect(redirect.origin + redirect.pathname).toBe('https://app.adport.dev/auth/callback');
    const recovery = new URL(redirect.searchParams.get('return_to')!, redirect.origin);
    expect(recovery.pathname).toBe('/auth/reset-password');
    expect(recovery.searchParams.get('return_to')).toBe('/dashboard/billing?plan=premium&billing=annual');
  });
  it('does not use an external recovery destination', async () => {
    const form = new FormData(); form.set('email', 'client@example.test'); form.set('return_to', 'https://attacker.example');
    await requestPasswordReset({}, form);
    expect(mocks.reset.mock.calls[0]![1].redirectTo).not.toContain('attacker');
  });
  it('validates addresses and returns recoverable errors without leaking provider details', async () => {
    expect(await requestPasswordReset({}, new FormData())).toEqual({ error: 'Enter a valid email address.' });
    expect(mocks.reset).not.toHaveBeenCalled();
    const form = new FormData(); form.set('email', 'client@example.test');
    mocks.reset.mockRejectedValueOnce(new Error('sensitive internal provider detail'));
    expect(await requestPasswordReset({}, form)).toEqual({ error: 'The reset email could not be sent. Check your connection and try again.' });
  });
  it('handles an expired PKCE reset link without losing the original destination', async () => {
    mocks.exchange.mockResolvedValue({ error: new Error('expired') });
    const recovery = '/auth/reset-password?return_to=' + encodeURIComponent('/dashboard/billing?plan=premium&billing=annual');
    const response = await callback(new Request('https://app.adport.dev/auth/callback?code=bad&return_to=' + encodeURIComponent(recovery)));
    const target = new URL(response.headers.get('location')!);
    expect(target.pathname).toBe('/auth/reset-password');
    expect(target.searchParams.get('error')).toBe('invalid');
    expect(target.searchParams.get('return_to')).toBe('/dashboard/billing?plan=premium&billing=annual');
  });
  it('accepts only complete recovery sessions and rejects unrelated auth fragments', () => {
    expect(passwordRecoveryTokens('')).toBeUndefined();
    expect(passwordRecoveryTokens('#type=recovery&access_token=local-only&refresh_token=local-only-refresh')).toEqual({ access_token: 'local-only', refresh_token: 'local-only-refresh' });
    expect(() => passwordRecoveryTokens('#type=invite&access_token=a&refresh_token=b')).toThrow('invalid or expired');
    expect(() => passwordRecoveryTokens('#error=access_denied')).toThrow('invalid or expired');
    expect(() => passwordRecoveryTokens('#type=recovery&access_token=a')).toThrow('incomplete');
  });
});
