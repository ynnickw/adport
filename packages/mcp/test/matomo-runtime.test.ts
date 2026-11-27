import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStore } from '@adport/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleRuntime } from '../src/index.js';

let home: string;
beforeEach(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'adport-matomo-runtime-'));
  vi.stubEnv('ADPORT_HOME', home); vi.stubEnv('ADPORT_DEMO', '');
  await new CredentialStore().set({ provider: 'meta', source: 'byo', data: { access_token: 'meta-test-token' } });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('runtime assembly with unusable Matomo credentials', () => {
  it.each(['http://matomo.internal', 'matomo.internal'])('skips Matomo and still loads other providers when MATOMO_URL is %s', async url => {
    vi.stubEnv('MATOMO_URL', url); vi.stubEnv('MATOMO_TOKEN_AUTH', 'test-token');
    const runtime = await assembleRuntime();
    const providers = runtime.ctx.providers.list().map(p => p.id), names = runtime.registry.list().map(t => t.name);
    expect(providers).toContain('meta'); expect(providers).not.toContain('matomo');
    expect(names).toContain('meta_insights'); expect(names.some(name => name.startsWith('matomo_'))).toBe(false);
  });

  it('skips an unusable stored Matomo record the same way', async () => {
    vi.stubEnv('MATOMO_URL', ''); vi.stubEnv('MATOMO_TOKEN_AUTH', '');
    await new CredentialStore().set({ provider: 'matomo', source: 'byo', data: { url: 'http://matomo.internal', token_auth: 'stored-token' } });
    const runtime = await assembleRuntime();
    expect(runtime.ctx.providers.list().map(p => p.id)).toEqual(expect.arrayContaining(['meta']));
    expect(runtime.ctx.providers.list().some(p => p.id === 'matomo')).toBe(false);
  });
});
