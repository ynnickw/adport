import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY } from '@adport/core';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { resetEnvForTests } from '@/lib/env';

vi.mock('@/lib/cloud/repository', () => ({
  getOrganizationPolicy: async () => DEFAULT_POLICY,
  listOrganizationAdAccounts: async () => [{ provider: 'microsoft', accountId: '777', name: 'Selected', enabled: true }],
  loadEnabledAccountIds: async () => ({ microsoft: new Set(['777']) }),
  loadProviderCredentials: async () => ({ microsoft: { refreshToken: 'not-a-real-token' } }),
  PostgresAuditStore: class {}, PostgresPendingStore: class {}, PostgresFindingsStore: class {},
}));

beforeEach(() => {
  vi.stubEnv('MICROSOFT_ADS_CLIENT_ID', 'test-client');
  vi.stubEnv('MICROSOFT_ADS_DEVELOPER_TOKEN', 'test-developer-token');
  resetEnvForTests();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected provider request'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetEnvForTests(); });

describe('Microsoft hosted media boundary', () => {
  it('requires project media before any OAuth or provider upload request', async () => {
    const runtime = await createTenantRuntime({ organizationId: 'org', scopes: ['tools:read', 'tools:write'] });
    await expect(runtime.ctx.providers.get('microsoft').previewWrite({ provider: 'microsoft', accountId: '777', tool: 'microsoft_upload_image', kind: 'create', payload: {
      file_path: '/tmp/not-a-hosted-upload.png', expected_sha256: 'a'.repeat(64),
    } }, { forcePausedCreation: true })).rejects.toThrow('Hosted uploads require a project media_id');
    expect(fetch).not.toHaveBeenCalled();
  });
});
