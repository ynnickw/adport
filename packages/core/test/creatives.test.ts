import { describe, expect, it } from 'vitest';
import { creativeSchema, creativeActionSchema, creativeStatusAction } from '../src/creatives.js';

describe('creative viewer contracts', () => {
  it('keeps immutable identifiers out of the editable field set and never accepts an approval token in an action', () => {
    const action = creativeStatusAction('google_set_ad_status', { account_id: '123', ad_id: '33' }, 'PAUSED', ['ENABLED', 'PAUSED']);
    expect(action.fields[0]?.key).toBe('status');
    expect(creativeActionSchema.safeParse({ ...action, arguments: { ...action.arguments, pending_operation_id: 'unreviewed' } }).success).toBe(false);
    expect(creativeActionSchema.safeParse({ ...action, fields: [{ ...action.fields[0], key: 'account_id' }] }).success).toBe(false);
    expect(creativeActionSchema.safeParse({ ...action, fields: [{ key: 'ad_id', label: 'Target', type: 'text', value: '34' }] }).success).toBe(false);
    expect(creativeSchema.safeParse({ id: '33', provider: 'google', account_id: 'other', name: 'Ad', type: 'RSA', actions: [action] }).success).toBe(false);
  });
  it('rejects active-content and credential-bearing media URLs', () => {
    const creative = { id: '1', provider: 'test', account_id: '2', name: 'Ad', type: 'IMAGE' };
    for (const url of ['javascript:alert(1)', 'http://example.com/image.png', 'https://secret@example.com/image.png']) {
      expect(creativeSchema.safeParse({ ...creative, media: [{ type: 'image', url }] }).success).toBe(false);
    }
  });
});
