import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ secret: 'local-cron-test', cleanup: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: () => ({ CRON_SECRET: mocks.secret }) }));
vi.mock('@/lib/cloud/media', () => ({ cleanupDeletedProjectMedia: mocks.cleanup }));
import { GET } from '@/app/api/media/cleanup/route';

describe('private media cleanup cron', () => {
  beforeEach(() => { mocks.secret = 'local-cron-test'; mocks.cleanup.mockReset().mockResolvedValue({ checked: 1, cleaned: 1, failed: 0 }); });
  it('requires the cron bearer secret before accessing storage', async () => {
    for (const authorization of ['', 'Bearer wrong-secret']) {
      expect((await GET(new Request('https://app.adport.test/api/media/cleanup', { headers: { authorization } }))).status).toBe(401);
    }
    expect(mocks.cleanup).not.toHaveBeenCalled();
    mocks.secret = '';
    expect((await GET(new Request('https://app.adport.test/api/media/cleanup'))).status).toBe(503);
  });
  it('reports successful cleanup and exposes failures for retry monitoring', async () => {
    const request = () => new Request('https://app.adport.test/api/media/cleanup', { headers: { authorization: 'Bearer local-cron-test' } });
    expect((await GET(request())).status).toBe(200);
    mocks.cleanup.mockResolvedValueOnce({ checked: 1, cleaned: 0, failed: 1 });
    expect((await GET(request())).status).toBe(500);
  });
});
