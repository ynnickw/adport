import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import { resetEnvForTests } from '@/lib/env';
import { rotateProviderTokens } from '@/lib/cloud/credential-rotation';

const mocks = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: () => ({ begin: (fn: (sql: unknown) => unknown) => fn(mocks.sql) }) }));
const aad = 'connection:org:spotify';
const input = { organizationId: 'org', provider: 'spotify' as const, connectionId: 'connection', expected: { refreshToken: 'old', selectedAccountIds: ['old-scope'] }, tokens: { refreshToken: 'rotated' } };

beforeEach(() => {
  vi.stubEnv('ADPORT_CLOUD_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  resetEnvForTests(); mocks.sql.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); resetEnvForTests(); });

describe('tenant credential rotation', () => {
  it('locks and merges tokens while preserving the current account selection', async () => {
    mocks.sql.mockResolvedValueOnce([{ ciphertext: encryptSecret({ refreshToken: 'old', selectedAccountIds: ['new-scope'] }, aad) }]).mockResolvedValueOnce([]);
    await rotateProviderTokens(input);
    const [select, ...scope] = mocks.sql.mock.calls[0]!;
    expect(select.join('?')).toMatch(/for update/);
    expect(scope).toEqual(['org', 'spotify', 'connection']);
    const [, ciphertext, ...updateScope] = mocks.sql.mock.calls[1]!;
    expect(updateScope).toEqual(['org', 'spotify', 'connection']);
    expect(decryptSecret(ciphertext, aad)).toEqual({ refreshToken: 'rotated', selectedAccountIds: ['new-scope'] });
  });

  it('does not overwrite a new grant that reuses the same connection id', async () => {
    mocks.sql.mockResolvedValueOnce([{ ciphertext: encryptSecret({ refreshToken: 'replacement', selectedAccountIds: [] }, aad) }]);
    await expect(rotateProviderTokens(input)).rejects.toThrow(/grant changed/);
    expect(mocks.sql).toHaveBeenCalledOnce();
  });

  it('does not resurrect a removed connection', async () => {
    mocks.sql.mockResolvedValueOnce([]);
    await expect(rotateProviderTokens(input)).rejects.toThrow(/removed/);
    expect(mocks.sql).toHaveBeenCalledOnce();
  });

  it('filters non-token properties out of a runtime patch', async () => {
    mocks.sql.mockResolvedValueOnce([{ ciphertext: encryptSecret({ refreshToken: 'old', selectedAccountIds: [] }, aad) }]).mockResolvedValueOnce([]);
    await rotateProviderTokens({ ...input, tokens: { refreshToken: 'rotated', selectedAccountIds: ['unauthorized'] } as typeof input.tokens });
    expect(decryptSecret(mocks.sql.mock.calls[1]![1], aad)).toEqual({ refreshToken: 'rotated', selectedAccountIds: [] });
  });

});
