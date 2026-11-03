import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: vi.fn(), rate: vi.fn(), read: vi.fn(), update: vi.fn(), revalidate: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/env', () => ({ env: () => ({ ADPORT_CLOUD_BASE_URL: 'https://app.adport.test' }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.user } }) }));
vi.mock('@/lib/cloud/repository', () => ({ enforceRateLimit: mocks.rate }));
vi.mock('@/lib/cloud/workspace-logos', () => ({ readWorkspaceLogo: mocks.read, updateWorkspaceLogo: mocks.update }));
import { DELETE, GET, POST } from '@/app/api/workspace-logos/[kind]/[id]/route';
import { HttpError } from '@/lib/http';
import { MAX_LOGO_BYTES } from '@/lib/workspace-logos';

const id = 'aa000000-0000-4000-8000-000000000001';
const context = () => ({ params: Promise.resolve({ kind: 'project', id }) });
function upload() {
  const form = new FormData();
  form.set('file', new File(['fixture'], 'logo.png', { type: 'image/png' }));
  return new Request(`https://app.adport.test/api/workspace-logos/project/${id}`, { method: 'POST', headers: { origin: 'https://app.adport.test' }, body: form });
}

describe('workspace logo HTTP boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ data: { user: { id: 'actor' } }, error: null });
    mocks.rate.mockResolvedValue(true);
    mocks.update.mockResolvedValue(`project/${id}/version.png`);
    mocks.read.mockResolvedValue(new Blob(['png']));
  });

  it('requires authentication for reads and writes', async () => {
    mocks.user.mockResolvedValue({ data: { user: null }, error: null });
    expect((await GET(upload(), context())).status).toBe(401);
    expect((await POST(upload(), context())).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects cross-origin mutations and rate-limited users', async () => {
    const request = upload(); request.headers.set('origin', 'https://attacker.test');
    expect((await POST(request, context())).status).toBe(403);
    mocks.rate.mockResolvedValue(false);
    expect((await POST(upload(), context())).status).toBe(429);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('limits multipart bodies even without content-length', async () => {
    const request = new Request('https://app.adport.test', { method: 'POST', headers: { origin: 'https://app.adport.test', 'content-type': 'multipart/form-data; boundary=fixture' }, body: new Uint8Array(MAX_LOGO_BYTES + 65_537) });
    expect((await POST(request, context())).status).toBe(413);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('uploads the file for the signed-in actor and refreshes all logo surfaces', async () => {
    const response = await POST(upload(), context());
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('actor', 'project', id, expect.any(File));
    expect(await response.json()).toEqual({ logoUrl: `/api/workspace-logos/project/${id}?v=version.png` });
    expect(mocks.revalidate).toHaveBeenCalledWith('/dashboard', 'layout');
  });

  it('removes logos through the same authorization service', async () => {
    mocks.update.mockResolvedValue(null);
    const response = await DELETE(new Request('https://app.adport.test', { method: 'DELETE', headers: { origin: 'https://app.adport.test' } }), context());
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('actor', 'project', id, null);
    expect(await response.json()).toEqual({ logoUrl: null });
  });

  it('serves private PNGs and does not expose inaccessible logos', async () => {
    const response = await GET(upload(), context());
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    mocks.read.mockRejectedValue(new HttpError('Logo not found or access denied.', 404));
    expect((await GET(upload(), context())).status).toBe(404);
  });
});
