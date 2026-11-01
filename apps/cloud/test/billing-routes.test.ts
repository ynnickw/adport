import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), process: vi.fn(), reconcile: vi.fn(), secret: 'cron-secret-fixture-00000000000000000000' as string | undefined }));
vi.mock('@/lib/env', () => ({ env: () => ({ STRIPE_WEBHOOK_SECRET: 'whsec_fixture', CRON_SECRET: mocks.secret }) }));
vi.mock('@/lib/cloud/billing', () => ({ processStripeEvent: mocks.process, reconcileBillingSubscriptions: mocks.reconcile, stripeClient: () => ({ webhooks: { constructEvent: mocks.verify } }) }));
import { POST } from '@/app/api/billing/webhook/route';
import { GET } from '@/app/api/billing/reconcile/route';
beforeEach(() => {
  vi.clearAllMocks(); mocks.secret = 'cron-secret-fixture-00000000000000000000';
  mocks.verify.mockReturnValue({ id: 'evt_fixture' }); mocks.process.mockResolvedValue('processed');
  mocks.reconcile.mockResolvedValue({ checked: 1, updated: 0, failed: 0 });
});
describe('billing route boundaries', () => {
  it('rejects unsigned or invalid webhook requests before processing', async () => {
    expect((await POST(new Request('https://example.test', { method: 'POST', body: '{}' }))).status).toBe(400);
    mocks.verify.mockImplementationOnce(() => { throw new Error('bad signature'); });
    expect((await POST(new Request('https://example.test', { method: 'POST', body: '{}', headers: { 'stripe-signature': 'invalid' } }))).status).toBe(400);
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it('acknowledges committed processing and returns a retryable error for transient failures', async () => {
    const request = () => new Request('https://example.test', { method: 'POST', body: '{"fixture":true}', headers: { 'stripe-signature': 'signed' } });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.verify).toHaveBeenCalledWith('{"fixture":true}', 'signed', 'whsec_fixture');
    mocks.process.mockRejectedValueOnce(new Error('temporary database failure'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await POST(request())).status).toBe(500); log.mockRestore();
  });
  it('never runs reconciliation without its configured bearer secret', async () => {
    expect((await GET(new Request('https://example.test'))).status).toBe(401);
    expect((await GET(new Request('https://example.test', { headers: { authorization: 'Bearer wrong' } }))).status).toBe(401);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    mocks.secret = undefined;
    expect((await GET(new Request('https://example.test'))).status).toBe(503);
  });
  it('reports failed reconciliations for monitoring instead of acknowledging success', async () => {
    const request = () => new Request('https://example.test', { headers: { authorization: 'Bearer ' + mocks.secret } });
    expect((await GET(request())).status).toBe(200);
    mocks.reconcile.mockResolvedValueOnce({ checked: 1, updated: 0, failed: 1 });
    expect((await GET(request())).status).toBe(500);
  });
});
