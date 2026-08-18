import { describe, expect, it } from 'vitest';
import { AdportError } from '@adport/core';
import { describeProviderError } from '@/lib/cloud/provider-errors';

describe('browser-safe provider errors', () => {
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
});
