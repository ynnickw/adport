import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST, PATCH } from '@/app/api/media/route';
import { DEFAULT_POLICY } from '@adport/core';

const mocks = vi.hoisted(() => ({ call: vi.fn(), session: vi.fn(), scope: vi.fn(), rate: vi.fn(), get: vi.fn(), list: vi.fn(), directBegin: vi.fn(), directFinalize: vi.fn() }));
vi.mock('@adport/core', async original => ({ ...await original<typeof import('@adport/core')>(), createContext: async () => ({ registry: { call: mocks.call }, ctx: {} }) }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session, requireScope: mocks.scope }));
vi.mock('@/lib/cloud/repository', () => ({ enforceRateLimit: mocks.rate, getOrganizationPolicy: async () => DEFAULT_POLICY, PostgresPendingStore: class {}, PostgresAuditStore: class {} }));
vi.mock('@/lib/cloud/media', async original => ({ ...await original<typeof import('@/lib/cloud/media')>(), ProjectMediaLibrary: class { get = mocks.get; list = mocks.list; beginUpload = mocks.directBegin; finalize = mocks.directFinalize; } }));
vi.mock('@/lib/env', () => ({ env: () => ({ ADPORT_CLOUD_BASE_URL: 'https://app.adport.test' }) }));
const projectId = '11111111-1111-4111-8111-111111111111', mediaId = '22222222-2222-4222-8222-222222222222', sha256 = 'a'.repeat(64);
const metadata = { name: 'qa.png', content_type: 'image/png', byte_length: 100, sha256 };
function request(method: string, body?: unknown, suffix = '') { return new Request(`https://app.adport.test/api/media?project_id=${projectId}${suffix}`, { method, headers: { origin: 'https://app.adport.test', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
beforeEach(() => { vi.resetAllMocks(); mocks.session.mockResolvedValue({ organizationId: projectId, userId: 'user', scopes: ['tools:read', 'tools:write'] }); mocks.rate.mockResolvedValue(true); mocks.get.mockResolvedValue({ id: mediaId, sha256 }); mocks.call.mockImplementation(async (_name, args) => args.pending_operation_id ? { result: { details: { media_id: mediaId, status: 'ready' } } } : { pending_operation_id: 'bound-approval' }); mocks.list.mockResolvedValue({ assets: [], truncated: false }); });
describe('dashboard upload policy adapter', () => {
  it('reserves a file through preview/apply rather than a direct staging write', async () => {
    expect((await POST(request('POST', metadata))).status).toBe(201);
    expect(mocks.call.mock.calls.map(([name]) => name)).toEqual(['media_prepare_upload', 'media_prepare_upload']);
    expect(mocks.call.mock.calls[0]![1]).toEqual(metadata); expect(mocks.call.mock.calls[1]![1]).toEqual({ ...metadata, pending_operation_id: 'bound-approval' });
    expect(mocks.directBegin).not.toHaveBeenCalled(); expect(mocks.session).toHaveBeenCalledWith(projectId);
  });
  it('finalizes through the same policy gate using the selected project’s stored checksum', async () => {
    expect((await PATCH(request('PATCH', { media_id: mediaId }))).status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith(mediaId); expect(mocks.call.mock.calls[0]).toEqual(['media_finalize_upload', { media_id: mediaId, expected_sha256: sha256 }, {}]);
    expect(mocks.call.mock.calls[1]![1]).toMatchObject({ pending_operation_id: 'bound-approval', expected_sha256: sha256 }); expect(mocks.directFinalize).not.toHaveBeenCalled();
  });
  it('passes normalized library filters without exposing another project', async () => {
    expect((await GET(request('GET', undefined, '&query=Launch&tag=SUMMER&kind=image&platform=meta&limit=10'))).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ query: 'Launch', tag: 'summer', kind: 'image', platform: 'meta', limit: 10 });
  });
  it.each(['PROCESSING', 'FAILED'])('finds %s uploads through the same authenticated read adapter', async status => {
    const response = await GET(request('GET', undefined, `&query=clipboard&status=${status}&limit=2`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.session).toHaveBeenCalledWith(projectId);
    expect(mocks.list).toHaveBeenCalledWith({ query: 'clipboard', status, limit: 2 });
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it('rejects unsupported upload states before searching', async () => {
    expect((await GET(request('GET', undefined, '&status=DELETED'))).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
