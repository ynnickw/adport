import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifySupportMessage } from '@/lib/cloud/support';
import { resetEnvForTests } from '@/lib/env';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.RESEND_API_KEY;
  delete process.env.SUPPORT_NOTIFICATION_EMAIL;
  resetEnvForTests();
});

describe('support notification', () => {
  it('escapes user content and sends through the default onboarding sender', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.SUPPORT_NOTIFICATION_EMAIL = 'owner@example.test';
    resetEnvForTests();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'email_test' }), { status: 200 }));
    await expect(notifySupportMessage({
      feedback: { id: 'feedback-id', kind: 'bug', subject: '<script>subject</script>', message: 'Broken <button>', pagePath: '/dashboard' , createdAt: new Date() },
      organizationName: 'Example & Co', senderName: 'A User', senderEmail: 'user@example.test',
    })).resolves.toBe('email_test');
    const request = fetchMock.mock.calls[0]!;
    expect(request[0]).toBe('https://api.resend.com/emails');
    const body = JSON.parse(String((request[1] as RequestInit).body)) as { from: string; to: string[]; html: string };
    expect(body.from).toBe('Adport Support <onboarding@resend.dev>');
    expect(body.to).toEqual(['owner@example.test']);
    expect(body.html).toContain('&lt;script&gt;subject&lt;/script&gt;');
    expect(body.html).not.toContain('<script>');
  });
});
