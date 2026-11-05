import { describe, expect, it } from 'vitest';
import type { WriteOperation } from '@adport/core';
import { openPendingOperation, sealPendingOperation } from '@/lib/cloud/pending-operation';

const op: WriteOperation = { tool: 'pinterest_create_feed', provider: 'pinterest', accountId: '123', kind: 'create', payload: { location: 'sftp://merchant.invalid/private?token=synthetic-capability', credentials: { username: 'synthetic-user', password: 'synthetic-password' } } };
describe('sealed pending write arguments', () => {
  it('round-trips exact arguments without storing passwords or source capabilities as JSON', () => {
    const sealed = sealPendingOperation('project-a', 'pending-a', op);
    for (const value of ['synthetic-password', 'synthetic-user', 'synthetic-capability', 'pinterest_create_feed']) expect(JSON.stringify(sealed)).not.toContain(value);
    expect(openPendingOperation('project-a', 'pending-a', sealed)).toEqual(op);
    expect(sealPendingOperation('project-a', 'pending-a', op)).not.toEqual(sealed);
  });
  it('binds ciphertext to both project and approval identity', () => {
    const sealed = sealPendingOperation('project-a', 'pending-a', op);
    expect(() => openPendingOperation('project-b', 'pending-a', sealed)).toThrow('could not be verified');
    expect(() => openPendingOperation('project-a', 'pending-b', sealed)).toThrow('could not be verified');
  });
  it('accepts valid legacy approvals without falling back from corrupt sealed envelopes', () => {
    expect(openPendingOperation('project-a', 'pending-a', op)).toEqual(op);
    for (const value of [{ ...op, sealed_operation: 'invalid' }, { sealed_operation: '' }, { ...sealPendingOperation('project-a', 'pending-a', op), payload: op.payload }, null]) expect(() => openPendingOperation('project-a', 'pending-a', value)).toThrow('could not be verified');
  });
});
