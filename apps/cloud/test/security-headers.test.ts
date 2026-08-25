import { describe, expect, it } from 'vitest';
import config, { buildContentSecurityPolicy } from '../next.config';

describe('content security policy', () => {
  const supabaseOrigin = 'https://example.supabase.co';

  it('keeps ordinary forms restricted to Adport', () => {
    const policy = buildContentSecurityPolicy(supabaseOrigin);
    expect(policy).toContain("form-action 'self'");
    expect(policy).not.toContain('form-action \'self\' https:');
  });

  it('allows registered HTTPS and loopback OAuth callbacks on the consent page', () => {
    const policy = buildContentSecurityPolicy(supabaseOrigin, true);
    expect(policy).toContain(
      "form-action 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*",
    );
  });

  it('limits the relaxed form navigation policy to the OAuth consent page', async () => {
    const configured = await config.headers?.();
    const general = configured?.find((entry) => entry.source === '/(.*)');
    const consent = configured?.find((entry) => entry.source === '/oauth/authorize');
    const value = (entry: typeof general) => entry?.headers.find(
      (header) => header.key === 'Content-Security-Policy',
    )?.value;

    expect(value(general)).toMatch(/form-action 'self'$/);
    expect(value(general)).not.toContain("form-action 'self' https:");
    expect(value(consent)).toContain(
      "form-action 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*",
    );
  });
});
