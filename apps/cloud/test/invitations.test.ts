import { describe, expect, it } from 'vitest';
import { invitationTokens, pendingInvitationRedirectUrl } from '@/lib/invitations';

describe('email invitations', () => {
  it('uses the approved callback and carries a pending invitation token', () => {
    const url = new URL(pendingInvitationRedirectUrl('https://app.adport.dev', 'fixture-token'));
    expect(url.pathname).toBe('/auth/callback');
    expect(url.searchParams.get('return_to')).toBe('/auth/invite?token=fixture-token');
    expect(url.hash).toBe('');
  });
  it('accepts only complete invitation sessions, not unrelated or expired fragments', () => {
    expect(invitationTokens('')).toBeUndefined();
    expect(invitationTokens('#type=invite&access_token=local-access&refresh_token=local-refresh')).toEqual({ access_token: 'local-access', refresh_token: 'local-refresh' });
    expect(() => invitationTokens('#type=recovery&access_token=local-access&refresh_token=local-refresh')).toThrow('invalid or expired');
    expect(() => invitationTokens('#type=invite&access_token=local-access')).toThrow('incomplete');
    expect(() => invitationTokens('#error=access_denied')).toThrow('invalid or expired');
    const signIn = '#type=magiclink&access_token=local-access&refresh_token=local-refresh';
    expect(invitationTokens(signIn, true)).toEqual({ access_token: 'local-access', refresh_token: 'local-refresh' });
    expect(() => invitationTokens(signIn)).toThrow('invalid or expired');
  });
});
