import { z } from 'zod';
import { AdportError } from '../errors.js';
import { DATE_PRESETS } from '../model.js';
import { defineTool, type AnyToolDefinition } from '../tools/registry.js';
import { AuditRunner } from './runner.js';
import { FindingsStore } from './store.js';

const dateRangeSchema = z.union([
  z.enum(DATE_PRESETS),
  z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
]);

export function auditTools(): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'audit_run',
      namespace: 'audit',
      description:
        'Run the cross-platform audit rule packs over connected accounts (campaign level). ' +
        'Returns structured findings with recommendations; some carry a ready-to-apply proposed action. ' +
        'Reads ad data only — never mutates anything.',
      input: z.object({
        provider: z.string().optional(),
        account_ids: z.array(z.string()).optional(),
        date_range: dateRangeSchema.default('last_30_days'),
      }),
      annotations: { readOnly: true },
      async handler(input, ctx) {
        const runner = new AuditRunner(ctx.providers);
        const result = await runner.run({
          provider: input.provider,
          accountIds: input.account_ids,
          dateRange: input.date_range,
        });
        return result;
      },
    }),
    defineTool({
      name: 'recommendations_list',
      namespace: 'audit',
      description: 'List persisted audit findings/recommendations (default: open ones), most severe first.',
      input: z.object({
        status: z.enum(['open', 'dismissed', 'applied']).default('open'),
        provider: z.string().optional(),
      }),
      annotations: { readOnly: true },
      async handler(input) {
        const findings = await new FindingsStore().list(input);
        return { findings, count: findings.length };
      },
    }),
    defineTool({
      name: 'recommendation_dismiss',
      namespace: 'audit',
      description: 'Dismiss a finding (it will not be re-opened by future audit runs).',
      input: z.object({ finding_id: z.string() }),
      annotations: { readOnly: false },
      async handler(input) {
        const finding = await new FindingsStore().setStatus(input.finding_id, 'dismissed');
        return { finding };
      },
    }),
    defineTool({
      name: 'recommendation_apply',
      namespace: 'audit',
      description:
        "Execute a finding's proposed action through the normal two-step write flow: first call returns the dry-run " +
        'preview and pending_operation_id; second call (with the id) applies and marks the finding applied.',
      input: z.object({
        finding_id: z.string(),
        pending_operation_id: z.string().optional(),
      }),
      annotations: { readOnly: false },
      async handler(input, ctx) {
        if (!ctx.registry) {
          throw new AdportError('PROVIDER_ERROR', 'recommendation_apply requires a tool registry in context');
        }
        const store = new FindingsStore();
        const finding = await store.get(input.finding_id);
        if (!finding) throw new AdportError('INVALID_INPUT', `Finding not found: ${input.finding_id}`);
        if (finding.status !== 'open') {
          throw new AdportError('INVALID_INPUT', `Finding ${input.finding_id} is ${finding.status}, not open`);
        }
        if (!finding.proposedAction) {
          throw new AdportError(
            'INVALID_INPUT',
            `Finding ${input.finding_id} has no proposed action — it needs human judgment (${finding.recommendation})`,
          );
        }
        const result = (await ctx.registry.call(
          finding.proposedAction.tool,
          {
            ...finding.proposedAction.input,
            ...(input.pending_operation_id ? { pending_operation_id: input.pending_operation_id } : {}),
          },
          ctx,
        )) as { status?: string };
        if (result.status === 'applied') {
          await store.setStatus(finding.id, 'applied');
        }
        return { finding_id: finding.id, action: finding.proposedAction, result };
      },
    }),
  ];
}
