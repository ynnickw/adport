import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerAllowedForOrganization } from '@/lib/cloud/provider-rollout';
import { resetEnvForTests } from '@/lib/env';

afterEach(() => { vi.unstubAllEnvs(); resetEnvForTests(); });

describe('new-provider organization rollout', () => {
  it('preserves normal availability when no test allowlist is configured', () => {
    vi.stubEnv('ADPORT_PROVIDER_TEST_ORGANIZATION_IDS', undefined); resetEnvForTests();
    expect(providerAllowedForOrganization('pinterest', 'org')).toBe(true);
  });
  it('uses exact organization matches for every new provider', () => {
    vi.stubEnv('ADPORT_PROVIDER_TEST_ORGANIZATION_IDS', ' owner-org, second-org '); resetEnvForTests();
    for (const provider of ['snapchat', 'spotify', 'pinterest', 'linkedin', 'x'] as const) {
      expect(providerAllowedForOrganization(provider, 'owner-org')).toBe(true);
      expect(providerAllowedForOrganization(provider, 'second-org')).toBe(true);
      expect(providerAllowedForOrganization(provider, 'org')).toBe(false);
      expect(providerAllowedForOrganization(provider)).toBe(false);
    }
    expect(providerAllowedForOrganization('google', 'other-org')).toBe(true);
  });
  it('fails closed for an explicitly empty allowlist', () => {
    vi.stubEnv('ADPORT_PROVIDER_TEST_ORGANIZATION_IDS', ' , '); resetEnvForTests();
    expect(providerAllowedForOrganization('pinterest', 'org')).toBe(false);
  });
});
