import 'server-only';
import type { WriteOperation } from '@adport/core';
import { z } from 'zod';
import { decryptSecret, encryptSecret } from '@/lib/crypto';

const operation = z.object({ tool: z.string().min(1), provider: z.string().min(1), accountId: z.string().min(1), kind: z.enum(['create', 'update', 'remove']), payload: z.record(z.string(), z.unknown()) }).strict();
const envelope = z.object({ sealed_operation: z.string().min(1) }).strict();
const binding = (projectId: string, pendingId: string) => `pending-operation:${projectId}:${pendingId}`;

export function sealPendingOperation(projectId: string, pendingId: string, value: WriteOperation) {
  return { sealed_operation: encryptSecret(operation.parse(value), binding(projectId, pendingId)) };
}

export function openPendingOperation(projectId: string, pendingId: string, value: unknown): WriteOperation {
  try {
    const wrapped = value !== null && typeof value === 'object' && Object.hasOwn(value, 'sealed_operation');
    return operation.parse(wrapped ? decryptSecret(envelope.parse(value).sealed_operation, binding(projectId, pendingId)) : value);
  } catch {
    throw new Error('Pending operation could not be verified. Request a new preview; do not replay this approval.');
  }
}
