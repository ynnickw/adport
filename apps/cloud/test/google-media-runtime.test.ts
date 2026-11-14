import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '@adport/core';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { resetEnvForTests } from '@/lib/env';

vi.mock('@/lib/cloud/repository', () => ({
  getOrganizationPolicy: async () => DEFAULT_POLICY,
  listOrganizationAdAccounts: async () => [{ provider: 'google', accountId: '1234567890', name: 'Selected', enabled: true }],
  loadEnabledAccountIds: async () => ({ google: new Set(['1234567890']) }),
  loadProviderCredentials: async () => ({ google: { refreshToken: 'not-a-real-token', loginCustomerIds: {} } }),
  PostgresAuditStore: class {}, PostgresPendingStore: class {}, PostgresFindingsStore: class {},
}));

beforeEach(() => {
  vi.stubEnv('GOOGLE_ADS_CLIENT_ID', 'test-client');
  vi.stubEnv('GOOGLE_ADS_CLIENT_SECRET', 'test-secret');
  resetEnvForTests();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected provider request'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetEnvForTests(); });

describe('Google hosted media boundary', () => {
  it('injects the project resolver and rejects server file paths before any OAuth or upload request', async () => {
    const runtime = await createTenantRuntime({ organizationId: 'org', scopes: ['tools:read', 'tools:write'] });
    await expect(runtime.ctx.providers.get('google').previewWrite({ provider: 'google', accountId: '1234567890', tool: 'google_upload_image_asset', kind: 'create', payload: {
      file_path: '/tmp/not-a-hosted-upload.png', expected_sha256: 'a'.repeat(64),
    } }, { forcePausedCreation: true })).rejects.toThrow('Hosted uploads require a project media_id');
    expect(fetch).not.toHaveBeenCalled();
  });
});
