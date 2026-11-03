import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ otp: vi.fn(), exchange: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: () => ({ ADPORT_CLOUD_BASE_URL: 'https://app.adport.dev' }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { signInWithOtp: mocks.otp, exchangeCodeForSession: mocks.exchange } }) }));
import { requestEmailLink } from '@/app/login/email-link/actions';
import { GET as callback } from '@/app/auth/callback/route';

function request(email = ' member@example.test ', returnTo = '/auth/invite?project_id=fixture') {
  const form = new FormData(); form.set('email', email); form.set('return_to', returnTo); return form;
}

describe('email-link sign in', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.otp.mockResolvedValue({ error: null }); });
  it('lets an invited account request a link without a password or creating another account', async () => {
    expect(await requestEmailLink({}, request())).toEqual({ sent: true });
    expect(mocks.otp).toHaveBeenCalledWith({
      email: 'member@example.test',
      options: { shouldCreateUser: false, emailRedirectTo: 'https://app.adport.dev/auth/callback?return_to=%2Fauth%2Finvite%3Fproject_id%3Dfixture' },
    });
  });
  it.each(['', 'not-an-email', 'x'.repeat(321) + '@example.test'])('rejects invalid email %s without contacting Auth', async email => {
    expect(await requestEmailLink({}, request(email))).toEqual({ error: 'Enter a valid email address.' });
    expect(mocks.otp).not.toHaveBeenCalled();
  });
  it.each(['otp_disabled', 'user_not_found', 'signup_disabled'])('does not expose whether an account exists for %s', async code => {
    mocks.otp.mockResolvedValue({ error: { code, message: 'internal account information' } });
    expect(await requestEmailLink({}, request())).toEqual({ sent: true });
  });
  it.each(['https://evil.example', '//evil.example', '/\\evil.example'])('sanitizes an unsafe post-login destination %s', async returnTo => {
    await requestEmailLink({}, request('member@example.test', returnTo));
    expect(mocks.otp.mock.calls[0]![0].options.emailRedirectTo).toBe('https://app.adport.dev/auth/callback?return_to=%2Fdashboard');
  });
  it('reports provider and network failures without leaking details', async () => {
    mocks.otp.mockResolvedValueOnce({ error: { code: 'over_email_send_rate_limit', message: 'private detail' } });
    expect(await requestEmailLink({}, request())).toEqual({ error: 'The sign-in email could not be sent. Wait a minute and try again.' });
    mocks.otp.mockRejectedValueOnce(new Error('private detail'));
    expect(await requestEmailLink({}, request())).toEqual({ error: 'The sign-in email could not be sent. Check your connection and try again.' });
  });
  it('exchanges an email code and returns to the invitation', async () => {
    mocks.exchange.mockResolvedValue({ error: null });
    const response = await callback(new Request('https://app.adport.dev/auth/callback?code=fixture&return_to=%2Fauth%2Finvite%3Fproject_id%3Dfixture'));
    expect(mocks.exchange).toHaveBeenCalledWith('fixture');
    expect(response.headers.get('location')).toBe('https://app.adport.dev/auth/invite?project_id=fixture');
  });
  it('returns an expired email code to sign in while keeping the invitation destination', async () => {
    mocks.exchange.mockResolvedValue({ error: new Error('expired') });
    const response = await callback(new Request('https://app.adport.dev/auth/callback?code=expired&return_to=%2Fauth%2Finvite%3Fproject_id%3Dfixture'));
    const target = new URL(response.headers.get('location')!);
    expect(target.pathname).toBe('/login');
    expect(target.searchParams.get('error')).toContain('invalid or expired');
    expect(target.searchParams.get('return_to')).toBe('/auth/invite?project_id=fixture');
  });
});
