import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  redirect: vi.fn((url: string): never => {
    throw new Error(`redirect:${url}`);
  }),
  signInWithOAuth: vi.fn(),
  signUp: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/env', () => ({ env: () => ({ ADPORT_CLOUD_BASE_URL: 'https://app.adport.dev' }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));

import { signInWithSocialProvider, signUp } from '@/app/login/actions';

describe('cloud social login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({ auth: { signInWithOAuth: mocks.signInWithOAuth, signUp: mocks.signUp } });
  });

  it.each(['google', 'github'] as const)('starts %s OAuth with the safe post-login path', async provider => {
    mocks.signInWithOAuth.mockResolvedValue({ data: { url: `https://${provider}.example/authorize` }, error: null });
    const formData = new FormData();
    formData.set('provider', provider);
    formData.set('return_to', '/oauth/authorize?client_id=adp_client_test');

    await expect(signInWithSocialProvider(formData)).rejects.toThrow(`redirect:https://${provider}.example/authorize`);
    expect(mocks.signInWithOAuth).toHaveBeenCalledWith({
      provider,
      options: {
        redirectTo: 'https://app.adport.dev/auth/callback?return_to=%2Foauth%2Fauthorize%3Fclient_id%3Dadp_client_test',
      },
    });
  });

  it('rejects unsupported providers before calling Supabase', async () => {
    const formData = new FormData();
    formData.set('provider', 'other');
    formData.set('return_to', 'https://evil.example/callback');

    await expect(signInWithSocialProvider(formData)).rejects.toThrow('redirect:/login?error=Unsupported+sign-in+provider');
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('keeps the chosen plan in signup errors and email-confirmation instructions', async () => {
    const form = new FormData(); form.set('email', 'new@example.test'); form.set('password', 'local-signup-fixture-only'); form.set('return_to', '/dashboard/billing?plan=premium&billing=annual');
    mocks.signUp.mockResolvedValueOnce({ data: {}, error: { message: 'Please retry' } });
    await expect(signUp(form)).rejects.toThrow('return_to=%2Fdashboard%2Fbilling%3Fplan%3Dpremium%26billing%3Dannual');
    mocks.signUp.mockResolvedValueOnce({ data: { session: null }, error: null });
    await expect(signUp(form)).rejects.toThrow('return_to=%2Fdashboard%2Fbilling%3Fplan%3Dpremium%26billing%3Dannual');
    expect(mocks.signUp.mock.calls[1]![0].options.emailRedirectTo).toContain('return_to=%2Fdashboard%2Fbilling%3Fplan%3Dpremium%26billing%3Dannual');
  });
});
