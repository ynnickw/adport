import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rate: vi.fn(), notify: vi.fn() }));
vi.mock('@/lib/cloud/repository', () => ({ enforceRateLimit: mocks.rate }));
vi.mock('@/lib/cloud/support', () => ({ notifyWebsiteSupportMessage: mocks.notify }));
import { OPTIONS, POST } from '@/app/api/public-support/route';

const body = { email: ' Person@Example.test ', kind: 'support', message: 'I have a question about connecting accounts.', pagePath: '/pricing', website: '' };
function request(value: unknown = body, origin = 'https://www.adport.dev') {
  return new Request('https://app.adport.dev/api/public-support', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
}

describe('public website support', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    mocks.rate.mockResolvedValue(true);
    mocks.notify.mockResolvedValue(undefined);
  });

  it('sends a validated message without requiring a tenant and returns no personal data', async () => {
    const result = await POST(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    expect(mocks.notify).toHaveBeenCalledWith({ ...body, email: 'person@example.test' });
    expect(result.headers.get('cache-control')).toBe('no-store');
  });

  it.each(['https://www.adport.dev', 'https://adport.dev', 'https://app.adport.dev'])('allows the exact website origin %s', async origin => {
    expect((await POST(request(body, origin))).status).toBe(200);
  });

  it.each(['', 'null', 'https://adport.dev.evil.test', 'https://evil.test'])('rejects untrusted origin %s', async origin => {
    expect((await POST(request(body, origin))).status).toBe(403);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('permits localhost only outside production', async () => {
    expect((await POST(request(body, 'http://127.0.0.1:4188'))).status).toBe(200);
    vi.stubEnv('NODE_ENV', 'production');
    expect((await POST(request(body, 'http://127.0.0.1:4188'))).status).toBe(403);
  });

  it.each([
    { ...body, email: 'bad' }, { ...body, message: 'short' }, { ...body, kind: 'unknown' },
    { ...body, to: 'attacker@example.test' }, { ...body, pagePath: '/pricing?secret=value' },
    { ...body, pagePath: '//evil.test/' }, { ...body, message: ' '.repeat(20) },
  ])('rejects invalid content or recipient/query injection', async value => {
    expect((await POST(request(value))).status).toBe(400);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('requires JSON and bounds the streamed body without trusting Content-Length', async () => {
    const plain = new Request('https://app.adport.dev/api/public-support', { method: 'POST', headers: { origin: 'https://adport.dev' }, body: 'hello' });
    expect((await POST(plain)).status).toBe(415);
    expect((await POST(request({ ...body, message: 'x'.repeat(40000) }))).status).toBe(413);
    const invalid = new Request('https://app.adport.dev/api/public-support', { method: 'POST', headers: { origin: 'https://adport.dev', 'content-type': 'application/json' }, body: '{' });
    expect((await POST(invalid)).status).toBe(400);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('drops honeypot submissions before rate-limiting or sending', async () => {
    expect(await (await POST(request({ ...body, website: 'bot' }))).json()).toEqual({ ok: true });
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('enforces both IP and global limits before notifying', async () => {
    mocks.rate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await POST(request());
    expect(result.status).toBe(429);
    expect(result.headers.get('retry-after')).toBe('60');
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('trusts only Vercel-provided client identity on Vercel', async () => {
    vi.stubEnv('VERCEL', '');
    const first = request(); first.headers.set('x-forwarded-for', 'untrusted');
    await POST(first);
    expect(mocks.rate).toHaveBeenCalledWith('website-support:ip:non-vercel', 5);
    vi.stubEnv('VERCEL', '1');
    const second = request(); second.headers.set('x-vercel-forwarded-for', '192.0.2.20');
    await POST(second);
    expect(mocks.rate).toHaveBeenCalledWith('website-support:ip:192.0.2.20', 5);
  });

  it('reports delivery failure without returning or logging private message data', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.notify.mockRejectedValue(new Error('person@example.test private provider failure'));
    const result = await POST(request());
    expect(result.status).toBe(503);
    expect(JSON.stringify(await result.json())).not.toContain('person@example.test');
    expect(log).toHaveBeenCalledWith('Website support delivery failed.');
    log.mockRestore();
  });

  it('answers preflight without sending or accessing tenant data', () => {
    expect(OPTIONS(request()).status).toBe(204);
    expect(OPTIONS(request(body, 'https://evil.test')).status).toBe(403);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
