import { describe, expect, it } from 'vitest';
import { reviewWrite } from '../src/tools/review.js';
import type { WriteOperation, WritePreview } from '../src/provider.js';

const operation = (payload: Record<string, unknown> = {}): WriteOperation => ({ tool: 'google_api_update', provider: 'google', accountId: '123', kind: 'update', payload });
const plan = (extra: Partial<WritePreview> = {}): WritePreview => ({ summary: 'Update "Brand search"', changes: [], budgetDeltas: [], coercions: [], serverValidated: false, ...extra });

describe('shared guarded-write review', () => {
  it('preserves every operation in batch payloads, arbitrary fields, nulls, and booleans', () => {
    const review = reviewWrite(operation({ service: 'Campaigns', updates: [{ update: { name: 'First', enabled: false } }, { update: { name: 'Second', end_time: null } }] }), plan({ changes: ['~ Campaigns {"name":"First"}', '~ Campaigns {"name":"Second"}'] }));
    expect(review.fields).toEqual([{ label: 'Updates', after: [{ update: { name: 'First', enabled: false } }, { update: { name: 'Second', end_time: null } }] }]);
    expect(review.provider).toBe('google'); expect(review.accountId).toBe('123');
  });
  it('only reports observed previous values, never a before value inferred from inputs', () => {
    const review = reviewWrite(operation({ status: 'PAUSED', fields: { name: 'New name' } }), plan({ changes: ['~ campaign 456 status ENABLED → PAUSED'] }));
    expect(review.fields).toEqual([{ label: 'Status', before: 'ENABLED', after: 'PAUSED' }, { label: 'Name', after: 'New name' }]);
    const unknown = reviewWrite(operation({ status: 'PAUSED' }), plan({ changes: ['~ campaign 456 status → PAUSED'] }));
    expect(unknown.fields[0]).not.toHaveProperty('before');
  });
  it('uses the exact structured budget delta and avoids duplicate input amounts', () => {
    const review = reviewWrite(operation({ daily_budget_micros: 1000001 }), plan({ budgetDeltas: [{ target: 'Daily budget', currency: 'USD', fromMicros: 1000000, toMicros: 1000001 }] }));
    expect(review.fields).toEqual([{ label: 'Daily budget', format: 'money', currency: 'USD', before: 1000000, after: 1000001 }]);
  });
  it('does not present requested active statuses as effective when policy adjusted them, even in batches', () => {
    const review = reviewWrite({ ...operation({ status: 'ACTIVE', body: { campaigns: [{ name: 'A', Status: 'Active' }, { name: 'B', entity_status: 'ACTIVE' }] } }), kind: 'create' }, plan({ coercions: ['status coerced to PAUSED by policy'] }));
    expect(JSON.stringify(review.fields)).not.toContain('ACTIVE'); expect(JSON.stringify(review.fields)).not.toContain('Active');
    expect(JSON.stringify(review.fields)).toContain('A'); expect(JSON.stringify(review.fields)).toContain('B');
  });
  it('keeps destructive IDs visible, flags shared scope, and preserves provider-authored rich fields', () => {
    const review = reviewWrite({ ...operation({ object_id: '456' }), kind: 'remove' }, plan({ changes: ['! shared resource affects other campaigns'] }));
    expect(review.fields).toEqual([{ label: 'Object id', after: '456' }]); expect(review.notices).toHaveLength(1);
    expect(reviewWrite(operation(), plan({ review }))).toBe(review);
  });
  it('omits credentials in nested inputs and uses metadata for binary uploads', () => {
    const review = reviewWrite(operation({ access_token: 'do-not-show', expected_parent_hash: 'f'.repeat(64), body: { objects: [{ client_secret: 'secret', expected_snapshot_hash: '0'.repeat(64), name: 'A' }], content_base64: 'AAAA' } }), plan());
    expect(JSON.stringify(review)).not.toContain('do-not-show'); expect(JSON.stringify(review)).not.toContain('secret');
    expect(JSON.stringify(review)).not.toContain('f'.repeat(64)); expect(JSON.stringify(review)).not.toContain('0'.repeat(64)); expect(JSON.stringify(review)).toContain('A');
    expect(review.fields).toContainEqual({ label: 'Content base64', after: 'Attached content (4 characters)' });
  });
  it('keeps customer records and nested conversion identifiers out of fallback reviews', () => {
    const review = reviewWrite(operation({ records_sha256: ['a'.repeat(64), 'b'.repeat(64)], hashes: ['d'.repeat(64)], events: [{ event_name: 'purchase', user: { email: 'private@example.com', ip_address: '192.0.2.1' }, user_identifiers: [{ hashed_email: 'e'.repeat(64) }] }], body: { user_data: [['c'.repeat(64)]] } }), plan());
    for (const value of ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), 'private@example.com', '192.0.2.1']) expect(JSON.stringify(review)).not.toContain(value);
    expect(review.fields).toContainEqual({ label: 'Records sha256', after: expect.stringMatching(/^Protected data \(2 records; SHA-256 [a-f0-9]{64}\)$/) });
    expect(JSON.stringify(review)).toContain('purchase');
  });
});
