import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/.well-known/openai-apps-challenge/route';
import { resetEnvForTests } from '@/lib/env';

afterEach(() => {
  delete process.env.OPENAI_APPS_CHALLENGE_TOKEN;
  resetEnvForTests();
});

describe('OpenAI plugin domain challenge', () => {
  it('fails closed until the portal token is configured', async () => {
    delete process.env.OPENAI_APPS_CHALLENGE_TOKEN;
    resetEnvForTests();
    const response = GET();
    expect(response.status).toBe(404);
  });

  it('returns only the exact configured token as plain text', async () => {
    process.env.OPENAI_APPS_CHALLENGE_TOKEN = 'openai-domain-token';
    resetEnvForTests();
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('openai-domain-token');
  });
});
