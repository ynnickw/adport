import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/media/actions/route';
import { HttpError } from '@/lib/http';

const mocks = vi.hoisted(() => ({ session: vi.fn(), runtime: vi.fn(), call: vi.fn(), scope: vi.fn(), rate: vi.fn() }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session, requireScope: mocks.scope }));
vi.mock('@/lib/cloud/runtime', () => ({ createTenantRuntime: mocks.runtime }));
vi.mock('@/lib/cloud/repository', () => ({ enforceRateLimit: mocks.rate }));
vi.mock('@/lib/env', () => ({ env: () => ({ ADPORT_CLOUD_BASE_URL: 'https://app.adport.test' }) }));
const project = '11111111-1111-4111-8111-111111111111';
function request(tool: string, args: Record<string, unknown> = {}, origin = 'https://app.adport.test') { return new Request(`https://app.adport.test/api/media/actions?project_id=${project}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ tool, arguments: args }) }); }
beforeEach(() => {
  vi.resetAllMocks(); mocks.session.mockResolvedValue({ userId: 'user', organizationId: project, scopes: ['tools:read', 'tools:write'] }); mocks.rate.mockResolvedValue(true);
  mocks.runtime.mockResolvedValue({ registry: { get: (name: string) => ({ annotations: { readOnly: name === 'media_get' } }), call: mocks.call }, ctx: {} });
  mocks.call.mockResolvedValue({ status: 'pending_validation', pending_operation_id: 'private-fixture' });
});
describe('central library action adapter', () => {
  it('sends previews and identical applies through the existing shared registry in the selected project', async () => {
    const args = { media_id: project, expected_sha256: 'a'.repeat(64), expected_version: 1, tags: ['launch'] };
    expect((await POST(request('media_update_metadata', args))).status).toBe(200);
    expect(mocks.session).toHaveBeenCalledWith(project); expect(mocks.scope).toHaveBeenCalledWith(expect.anything(), 'tools:write'); expect(mocks.call).toHaveBeenLastCalledWith('media_update_metadata', args, {});
    await POST(request('media_update_metadata', { ...args, pending_operation_id: 'private-fixture' }));
    expect(mocks.call).toHaveBeenLastCalledWith('media_update_metadata', { ...args, pending_operation_id: 'private-fixture' }, {});
  });
  it('checks source origin and restricts this adapter to library/upload operations', async () => {
    expect((await POST(request('media_update_metadata', {}, 'https://untrusted.test'))).status).toBe(403); expect(mocks.session).not.toHaveBeenCalled();
    expect((await POST(request('meta_upload_image'))).status).toBe(400); expect(mocks.call).not.toHaveBeenCalled();
    expect((await POST(request('media_distribution_plan'))).status).toBe(400); expect(mocks.call).not.toHaveBeenCalled();
    expect((await POST(request('meta_set_budget'))).status).toBe(400); expect(mocks.call).not.toHaveBeenCalled();
    expect((await POST(request('meta_create_campaign'))).status).toBe(400); expect(mocks.call).not.toHaveBeenCalled();
  });
  it('denies a read-only user before any native preview or apply', async () => {
    mocks.scope.mockImplementation((_principal, scope) => { if (scope === 'tools:write') throw new HttpError('Read only', 403); });
    expect((await POST(request('media_update_metadata'))).status).toBe(403); expect(mocks.call).not.toHaveBeenCalled();
    expect((await POST(request('media_get'))).status).toBe(200);
  });
  it('bounds streamed inputs even without Content-Length', async () => {
    const input = new Request(`https://app.adport.test/api/media/actions?project_id=${project}`, { method: 'POST', headers: { origin: 'https://app.adport.test' }, body: 'x'.repeat(32_769) });
    expect((await POST(input)).status).toBe(413); expect(mocks.call).not.toHaveBeenCalled();
  });
});
