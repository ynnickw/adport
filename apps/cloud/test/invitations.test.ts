import { describe, expect, it } from 'vitest';
import { invitationRedirectUrl, invitationTokens } from '@/lib/invitations';

describe('email invitations', () => {
  it('uses the existing approved callback and carries only a project hint', () => {
    const url = new URL(invitationRedirectUrl('https://app.adport.dev', 'project-id'));
    expect(url.pathname).toBe('/auth/callback');
    expect(url.searchParams.get('return_to')).toBe('/auth/invite?project_id=project-id');
    expect(url.hash).toBe('');
  });
  it('accepts only complete invitation sessions, not unrelated or expired fragments', () => {
    expect(invitationTokens('')).toBeUndefined();
    expect(invitationTokens('#type=invite&access_token=local-access&refresh_token=local-refresh')).toEqual({ access_token: 'local-access', refresh_token: 'local-refresh' });
    expect(() => invitationTokens('#type=recovery&access_token=local-access&refresh_token=local-refresh')).toThrow('invalid or expired');
    expect(() => invitationTokens('#type=invite&access_token=local-access')).toThrow('incomplete');
    expect(() => invitationTokens('#error=access_denied')).toThrow('invalid or expired');
  });
});
