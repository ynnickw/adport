import { z } from 'zod';
import type { AdProvider, WriteKind, WriteOperation } from '../provider.js';
import { defineTool, type AnyToolDefinition, type ToolContext } from './registry.js';
import { writeOutput } from './outputs.js';
import { reviewWrite } from './review.js';
import { MEDIA_UPLOAD_TOOLS } from './media-distribution.js';

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
  openWorld?: boolean;
  fileInputs?: AnyToolDefinition['fileInputs'];
  sensitiveInputs?: AnyToolDefinition['sensitiveInputs'];
  catalog?: AnyToolDefinition['catalog'];
  /** Project resources use the same policy gate without inventing an ad account. */
  contextTarget?: (ctx: ToolContext) => { provider: AdProvider; accountId: string };
}): AnyToolDefinition {
  const input = def.payload.safeExtend({
    ...(def.contextTarget ? {} : { account_id: z.string().min(1).describe('Target account id') }),
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
    output: writeOutput,
    ...(def.catalog ? { catalog: def.catalog } : {}),
    ...(def.fileInputs ? { fileInputs: def.fileInputs } : {}),
    ...(def.sensitiveInputs ? { sensitiveInputs: def.sensitiveInputs } : {}),
    annotations: { readOnly: false, destructive: def.destructive ?? !MEDIA_UPLOAD_TOOLS.has(def.name), ...(def.openWorld === undefined ? {} : { openWorld: def.openWorld }) },
    async handler(raw, ctx) {
      const { account_id, pending_operation_id, ...payload } = raw as Record<string, unknown> & {
        account_id: string;
        pending_operation_id?: string;
      };
      const target = def.contextTarget?.(ctx);
      let provider = target?.provider ?? ctx.providers.get(def.provider);
      const trackUpload = ctx.media?.trackUpload?.bind(ctx.media);
      if (trackUpload && MEDIA_UPLOAD_TOOLS.has(def.name) && typeof payload.media_id === 'string' && typeof payload.expected_sha256 === 'string') {
        const native = provider, media_id = payload.media_id, expected_sha256 = payload.expected_sha256;
        provider = { id: native.id, capabilities: () => native.capabilities(), listAccounts: () => native.listAccounts(), report: query => native.report(query), previewWrite: (op, guard) => native.previewWrite(op, guard),
          applyWrite: (op, guard) => trackUpload({ media_id, expected_sha256, provider: native.id, account_id, tool: def.name }, () => native.applyWrite(op, guard)) };
      }
      const op: WriteOperation = {
        tool: def.name,
        provider: def.provider,
        accountId: target?.accountId ?? account_id,
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
          preview: { ...outcome.preview, review: reviewWrite(op, outcome.preview) },
          next_step:
            'Review the preview. To apply, call this tool again with the same arguments plus pending_operation_id.',
        };
      }
      const outcome = await ctx.engine.apply(provider, op, pending_operation_id);
      return { status: 'applied', applied: true, result: outcome.result, preview: { ...outcome.preview, review: reviewWrite(op, outcome.preview) } };
    },
  });
}
