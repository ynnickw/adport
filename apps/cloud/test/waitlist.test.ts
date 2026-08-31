import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rate: vi.fn(), join: vi.fn() }));
vi.mock('@/lib/cloud/repository', () => ({ enforceRateLimit: mocks.rate }));
vi.mock('@/lib/cloud/waitlist', () => ({ joinCloudWaitlist: mocks.join }));
import { OPTIONS, POST } from '@/app/api/waitlist/route';

function request(body: unknown = { email: '  Person@Example.com ', consent: true }, origin = 'https://adport.dev') {
  return new Request('https://app.adport.dev/api/waitlist', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('public cloud waitlist', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    mocks.rate.mockResolvedValue(true);
    mocks.join.mockResolvedValue(undefined);
  });

  it('normalizes the email, persists consent, and does not expose the address', async () => {
    const result = await POST(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    expect(mocks.join).toHaveBeenCalledWith('person@example.com');
    expect(result.headers.get('cache-control')).toBe('no-store');
  });

  it.each(['https://adport.dev', 'https://www.adport.dev', 'https://app.adport.dev'])('allows the exact origin %s', async origin => {
    const result = await POST(request(undefined, origin));
    expect(result.status).toBe(200);
    expect(result.headers.get('access-control-allow-origin')).toBe(origin);
  });

  it.each(['https://adport.dev.evil.test', 'https://evil.test', 'null', ''])('rejects untrusted/missing origin %s', async origin => {
    expect((await POST(request(undefined, origin))).status).toBe(403);
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it('only permits local origins outside production', async () => {
    expect((await POST(request(undefined, 'http://127.0.0.1:4173'))).status).toBe(200);
    vi.stubEnv('NODE_ENV', 'production');
    expect((await POST(request(undefined, 'http://127.0.0.1:4173'))).status).toBe(403);
  });

  it.each([{ email: 'bad', consent: true }, { email: 'person@example.com' }, { email: 'person@example.com', consent: false }, { email: 'person@example.com', consent: true, unexpected: 1 }])('rejects invalid submissions', async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and non-JSON bodies', async () => {
    expect((await POST(new Request('https://app.adport.dev/api/waitlist', { method: 'POST', headers: { origin: 'https://adport.dev', 'content-type': 'application/json' }, body: '{' }))).status).toBe(400);
    expect((await POST(new Request('https://app.adport.dev/api/waitlist', { method: 'POST', headers: { origin: 'https://adport.dev' }, body: 'email=test' }))).status).toBe(415);
  });

  it('bounds the body without relying on Content-Length', async () => {
    expect((await POST(request({ email: 'x'.repeat(3000), consent: true }))).status).toBe(413);
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it('silently discards honeypot submissions', async () => {
    expect(await (await POST(request({ email: 'bot@example.com', consent: true, website: 'spam' }))).json()).toEqual({ ok: true });
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it('returns the same result for repeated emails', async () => {
    expect(await (await POST(request())).json()).toEqual(await (await POST(request())).json());
  });

  it('rate-limits requests and provides a retry interval', async () => {
    mocks.rate.mockResolvedValue(false);
    const result = await POST(request());
    expect(result.status).toBe(429);
    expect(result.headers.get('retry-after')).toBe('60');
    expect(mocks.join).not.toHaveBeenCalled();
  });

  it('does not trust generic forwarded headers', async () => {
    vi.stubEnv('VERCEL', '');
    const req = request();
    req.headers.set('x-forwarded-for', 'attacker-controlled');
    await POST(req);
    expect(mocks.rate).toHaveBeenCalledWith('waitlist:ip:non-vercel', 5);
  });

  it('uses Vercel-provided client identity when deployed there', async () => {
    vi.stubEnv('VERCEL', '1');
    const req = request();
    req.headers.set('x-vercel-forwarded-for', '192.0.2.10');
    await POST(req);
    expect(mocks.rate).toHaveBeenCalledWith('waitlist:ip:192.0.2.10', 5);
  });

  it('returns a safe retryable failure without logging PII', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.join.mockRejectedValue(new Error('person@example.com SQL failure'));
    const result = await POST(request());
    expect(result.status).toBe(503);
    expect(JSON.stringify(await result.json())).not.toContain('person@example.com');
    expect(log).toHaveBeenCalledWith('Cloud waitlist signup failed.');
    log.mockRestore();
  });

  it('supports exact-origin preflight without database access', () => {
    expect(OPTIONS(request()).status).toBe(204);
    expect(OPTIONS(request(undefined, 'https://evil.test')).status).toBe(403);
    expect(mocks.join).not.toHaveBeenCalled();
  });
});
