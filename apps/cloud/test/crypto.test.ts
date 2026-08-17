import { describe, expect, it } from 'vitest';
import { decryptSecret, digestApiKey, digestState, encryptSecret } from '@/lib/crypto';

describe('cloud secret protection', () => {
  it('round-trips authenticated ciphertext and binds it to its tenant AAD', () => {
    const encrypted = encryptSecret({ refreshToken: 'secret-token' }, 'connection:org-a:google');
    expect(encrypted).not.toContain('secret-token');
    expect(decryptSecret(encrypted, 'connection:org-a:google')).toEqual({ refreshToken: 'secret-token' });
    expect(() => decryptSecret(encrypted, 'connection:org-b:google')).toThrow();
  });

  it('produces stable non-reversible digests for OAuth state and API keys', () => {
    expect(digestState('state')).toBe(digestState('state'));
    expect(digestApiKey('adp_example')).toBe(digestApiKey('adp_example'));
    expect(digestState('state')).not.toContain('state');
    expect(digestApiKey('adp_example')).not.toContain('adp_example');
  });
});
