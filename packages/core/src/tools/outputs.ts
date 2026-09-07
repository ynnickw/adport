import { z } from 'zod';
import { DATE_PRESETS, ENTITY_LEVELS, METRICS } from '../model.js';

const dateRange = z.object({ start: z.string(), end: z.string() });
const providerError = z.object({ provider: z.string(), message: z.string() });
const metrics = z.object(Object.fromEntries(METRICS.map(name => [name, z.number().nullable().optional()])));
const entity = z.object({ level: z.string(), id: z.string(), name: z.string(), status: z.string().optional() });
const action = z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()) });

export const accountsOutput = z.object({
  accounts: z.array(z.object({
    provider: z.string(), id: z.string(), name: z.string(),
    currency: z.string().optional(), status: z.string().optional(),
  })),
  errors: z.array(providerError),
});

export const reportOutput = z.object({
  rows: z.array(z.object({
    provider: z.string(), accountId: z.string(), currency: z.string().optional(),
    entity: entity.extend({ level: z.enum(ENTITY_LEVELS) }), metrics,
  })),
  summary: z.object({
    scope: z.literal('returned_rows'), complete: z.boolean(),
    groups: z.array(z.object({
      key: z.string(), currency: z.string().nullable(),
      accounts: z.array(z.object({ provider: z.string(), account_id: z.string() })),
      row_count: z.number().int().nonnegative(),
      metrics: z.object({
        spend: z.number().nullable(), impressions: z.number().nullable(), clicks: z.number().nullable(),
        conversions: z.number().nullable(), conversion_value: z.number().nullable(), roas: z.number().nullable(),
      }),
      roas_method: z.enum(['conversion_value_over_spend', 'spend_weighted_reported_roas']).nullable(),
    })),
  }),
  truncated: z.boolean(), errors: z.array(providerError), warnings: z.array(providerError),
  date_range: z.union([z.enum(DATE_PRESETS), dateRange]),
});

export const findingOutput = z.object({
  id: z.string(), ruleId: z.string(), severity: z.enum(['info', 'warn', 'critical']),
  provider: z.string(), accountId: z.string(), entity,
  title: z.string(), detail: z.string(), recommendation: z.string(),
  proposedAction: action.optional(), metrics, dateRange,
  status: z.enum(['open', 'dismissed', 'applied']), createdAt: z.string(), updatedAt: z.string(),
});

export const auditOutput = z.object({
  findings: z.array(findingOutput),
  counts: z.object({ critical: z.number().int().nonnegative(), warn: z.number().int().nonnegative(), info: z.number().int().nonnegative() }),
  evaluatedAccounts: z.number().int().nonnegative(), range: dateRange,
});

const preview = z.object({
  summary: z.string(), changes: z.array(z.string()), coercions: z.array(z.string()),
  budgetDeltas: z.array(z.object({
    target: z.string(), currency: z.string().optional(), fromMicros: z.number().optional(), toMicros: z.number(),
  })),
  serverValidated: z.boolean(),
});
const pending = z.object({
  status: z.literal('pending_validation'), applied: z.literal(false),
  pending_operation_id: z.string(), expires_at: z.string(), preview, next_step: z.string(),
});
const applied = z.object({
  status: z.literal('applied'), applied: z.literal(true), preview,
  result: z.object({ applied: z.literal(true), resourceIds: z.array(z.string()), details: z.unknown().optional() }),
});

// Flat wire format is retained for existing CLI/REST consumers. Phase-specific
// fields are optional because the same tool returns either preview or apply.
export const writeOutput = z.object({
  status: z.enum(['pending_validation', 'applied']),
  applied: z.boolean(),
  preview,
  pending_operation_id: z.string().optional().describe('Present for pending_validation; pass with identical arguments to apply.'),
  expires_at: z.string().optional().describe('Pending operation expiry, present for pending_validation.'),
  next_step: z.string().optional(),
  result: applied.shape.result.optional().describe('Provider result, present after successful apply.'),
});

export const recommendationsOutput = z.object({ findings: z.array(findingOutput), count: z.number().int().nonnegative() });
export const dismissOutput = z.object({ finding: findingOutput });
export const recommendationApplyOutput = z.object({
  finding_id: z.string(), action, result: z.discriminatedUnion('status', [pending, applied]),
});
