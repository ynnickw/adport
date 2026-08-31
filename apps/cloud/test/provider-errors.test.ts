import { describe, expect, it } from 'vitest';
import { AdportError } from '@adport/core';
import { describeProviderError } from '@/lib/cloud/provider-errors';

describe('browser-safe provider errors', () => {
  it.each(['Google Ads', 'Snapchat', 'Spotify', 'Pinterest', 'LinkedIn', 'X'])('does not mislabel a %s permission failure as an expired grant', name => {
    const text = describeProviderError(new AdportError('PROVIDER_ERROR', `${name}: HTTP 403. secret-token invalid permissions`));
    expect(text).toContain('Check API application approval');
    expect(text).not.toContain('invalid, expired, or revoked');
    expect(text).not.toContain('secret-token');
  });
  it('never echoes tokens or CLI instructions', () => {
    const raw = new AdportError('PROVIDER_ERROR', 'Meta Marketing API error (HTTP 401, code 190): Malformed access token EAAB-secret-token The access token is invalid or expired — re-run `adport connect meta`.');
    const text = describeProviderError(raw);
    expect(text).not.toContain('EAAB-secret-token');
    expect(text).not.toContain('adport connect');
    expect(text).toContain('Meta Ads');
    expect(text).toContain('HTTP 401');
    expect(text).toContain('re-authorize');
  });

  it('keeps generic provider failures generic', () => {
    expect(describeProviderError(new AdportError('PROVIDER_ERROR', 'TikTok API error 50000: internal'), 'tiktok')).toMatch(/TikTok Ads request failed/);
    expect(describeProviderError(new Error('No ad providers are connected.'))).toBe('No ad platform is connected yet.');
  });

  it('does not mislabel Google customer permissions as an expired OAuth grant', () => {
    const text = describeProviderError(new AdportError(
      'PROVIDER_ERROR',
      "Google Ads API error (HTTP 403): The caller does not have permission. User doesn't have permission to access customer; set login-customer-id.",
    ), 'google');
    expect(text).toContain('account access failed (HTTP 403)');
    expect(text).toContain('manager account');
    expect(text).not.toContain('invalid, expired, or revoked');
  });
});
