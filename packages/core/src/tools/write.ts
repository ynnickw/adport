import { z } from 'zod';
import type { AdProvider, WriteKind, WriteOperation } from '../provider.js';
import { additionalAccountIds, defineTool, type AnyToolDefinition, type ToolContext } from './registry.js';
import { writeOutput } from './outputs.js';
import { reviewWrite } from './review.js';
import { MEDIA_UPLOAD_TOOLS } from './media-distribution.js';

const TWO_STEP_NOTE =
  'Apply with IDENTICAL arguments and the ID from preview.';

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
  sourceProviders?: AnyToolDefinition['sourceProviders'];
  kind: WriteKind;
  payload: S;
  hosted?: { description: string; payload: z.ZodObject<z.ZodRawShape> };
  destructive?: boolean;
  openWorld?: boolean;
  fileInputs?: AnyToolDefinition['fileInputs'];
  sensitiveInputs?: AnyToolDefinition['sensitiveInputs'];
  additionalAccountInputs?: AnyToolDefinition['additionalAccountInputs'];
  catalog?: AnyToolDefinition['catalog'];
  /** Resolve project resources or an explicitly selected provider before entering the policy gate. */
  contextTarget?: (ctx: ToolContext, input: z.infer<S>) => { provider: AdProvider; accountId: string };
}): AnyToolDefinition {
  const approvalFields = {
    ...(def.contextTarget ? {} : { account_id: z.string().min(1) }),
    pending_operation_id: z
      .string()
      .optional()
      .describe('Omit to preview. Supply to apply.'),
  };

  return defineTool({
    name: def.name,
    namespace: def.namespace,
    ...(def.sourceProviders ? { sourceProviders: def.sourceProviders } : {}),
    description: `${def.description}\n\n${TWO_STEP_NOTE}`,
    input: def.payload.safeExtend(approvalFields),
    ...(def.hosted ? { hosted: {
      description: `${def.hosted.description}\n\n${TWO_STEP_NOTE}`,
      input: def.hosted.payload.safeExtend(approvalFields),
    } } : {}),
    output: writeOutput,
    ...(def.catalog ? { catalog: def.catalog } : {}),
    ...(def.fileInputs ? { fileInputs: def.fileInputs } : {}),
    ...(def.sensitiveInputs ? { sensitiveInputs: def.sensitiveInputs } : {}),
    ...(def.additionalAccountInputs ? { additionalAccountInputs: def.additionalAccountInputs } : {}),
    annotations: { readOnly: false, destructive: def.destructive ?? !MEDIA_UPLOAD_TOOLS.has(def.name), ...(def.openWorld === undefined ? {} : { openWorld: def.openWorld }) },
    async handler(raw, ctx) {
      const { account_id, pending_operation_id, ...payload } = raw as Record<string, unknown> & {
        account_id: string;
        pending_operation_id?: string;
      };
      const target = def.contextTarget?.(ctx, raw as z.infer<S>);
      let provider = target?.provider ?? ctx.providers.get(def.provider);
      const trackUpload = ctx.media?.trackUpload?.bind(ctx.media);
      if (trackUpload && MEDIA_UPLOAD_TOOLS.has(def.name) && typeof payload.media_id === 'string' && typeof payload.expected_sha256 === 'string') {
        const native = provider, media_id = payload.media_id, expected_sha256 = payload.expected_sha256;
        provider = { id: native.id, capabilities: () => native.capabilities(), listAccounts: () => native.listAccounts(), report: query => native.report(query), previewWrite: (op, guard) => native.previewWrite(op, guard),
          applyWrite: (op, guard) => trackUpload({ media_id, expected_sha256, provider: native.id, account_id, tool: def.name }, () => native.applyWrite(op, guard)) };
      }
      const accounts = additionalAccountIds(def, payload);
      const op: WriteOperation = {
        tool: def.name,
        provider: target?.provider.id ?? def.provider,
        accountId: target?.accountId ?? account_id,
        ...(accounts.length ? { affectedAccountIds: accounts } : {}),
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
