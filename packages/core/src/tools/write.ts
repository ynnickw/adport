import { z } from 'zod';
import type { WriteKind, WriteOperation } from '../provider.js';
import { defineTool, type AnyToolDefinition } from './registry.js';

const TWO_STEP_NOTE =
  'Two-step write: call WITHOUT pending_operation_id to get a dry-run preview and a pending_operation_id; ' +
  'call again with IDENTICAL arguments plus that id to apply.';

/**
 * Wrap a provider mutation as a two-step (validate → apply) tool.
 * This is the only sanctioned way to expose a write; the handler always goes
 * through the policy engine, so rails and audit logging cannot be skipped.
 */
export function guardedWriteTool<S extends z.ZodObject<z.ZodRawShape>>(def: {
  name: string;
  namespace: string;
  description: string;
  provider: string;
  kind: WriteKind;
  payload: S;
  destructive?: boolean;
}): AnyToolDefinition {
  const input = def.payload.extend({
    account_id: z.string().min(1).describe('Target account id'),
    pending_operation_id: z
      .string()
      .optional()
      .describe('Omit to get a dry-run preview; pass the returned id to apply.'),
  });

  return defineTool({
    name: def.name,
    namespace: def.namespace,
    description: `${def.description}\n\n${TWO_STEP_NOTE}`,
    input,
    annotations: { readOnly: false, destructive: def.destructive ?? false },
    async handler(raw, ctx) {
      const { account_id, pending_operation_id, ...payload } = raw as Record<string, unknown> & {
        account_id: string;
        pending_operation_id?: string;
      };
      const provider = ctx.providers.get(def.provider);
      const op: WriteOperation = {
        tool: def.name,
        provider: def.provider,
        accountId: account_id,
        kind: def.kind,
        payload,
      };
      if (!pending_operation_id) {
        const outcome = await ctx.engine.validate(provider, op);
        return {
          status: 'pending_validation',
          applied: false,
          pending_operation_id: outcome.pendingOperationId,
          expires_at: outcome.expiresAt,
          preview: outcome.preview,
          next_step:
            'Review the preview. To apply, call this tool again with the same arguments plus pending_operation_id.',
        };
      }
      const outcome = await ctx.engine.apply(provider, op, pending_operation_id);
      return { status: 'applied', applied: true, result: outcome.result, preview: outcome.preview };
    },
  });
}
