import { describe, expect, it } from 'vitest';
import { AdportError } from '../src/errors.js';
import { failureAuditDetails } from '../src/policy/failure.js';

describe('unconfirmed apply audit diagnostics', () => {
  it.each([
    ['google', 'customers/123/campaigns/456'], ['meta', '12345'], ['tiktok', '12345'], ['apple', '12345'], ['microsoft', '12345'], ['pinterest', '12345'],
    ['linkedin', 'urn:li:document:D5610AQfixture'], ['linkedin', 'urn:li:ugcPost:12345'], ['linkedin', '1027072088'], ['linkedin', '6755260984438374401'], ['x', '13_12345'], ['reddit', 't3_fixture'],
    ['snapchat', '11111111-1111-4111-8111-111111111111'], ['spotify', '11111111-1111-4111-8111-111111111111'], ['media', '11111111-1111-4111-8111-111111111111'],
  ])('keeps a bounded %s native resource ID without arbitrary provider fields', (provider, id) => {
    const result = failureAuditDetails(provider, new AdportError('PROVIDER_ERROR', 'private message', { resource_ids: [id, id, 'https://private.invalid?signature=secret', 'user@example.com'], upload_url: 'private-capability', resource_receipt: 'private-receipt', customer_record: 'private-record' }));
    expect(result).toEqual({ phase: 'apply_failed', outcome: 'UNCONFIRMED', error_code: 'PROVIDER_ERROR', resourceIds: [id] });
  });
  it('excludes unexpected exceptions and unknown provider ID grammars', () => {
    expect(failureAuditDetails('google', new Error('private'))).toEqual({ phase: 'apply_failed', outcome: 'UNCONFIRMED' });
    expect(failureAuditDetails('__proto__', new AdportError('PROVIDER_ERROR', 'private', { resource_ids: ['private'] }))).not.toHaveProperty('resourceIds');
    const id = '11111111-1111-4111-8111-111111111111';
    expect(failureAuditDetails('media', new AdportError('PROVIDER_ERROR', 'private', { media_id: id }))).toHaveProperty('resourceIds', [id]);
    expect(failureAuditDetails('meta', new AdportError('PROVIDER_ERROR', 'private', { resourceIds: Array.from({ length: 200 }, (_, index) => String(index + 1)) })).resourceIds).toHaveLength(100);
  });
});
