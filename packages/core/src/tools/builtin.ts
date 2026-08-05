import { z } from 'zod';
import { DATE_PRESETS, ENTITY_LEVELS, METRICS, type NormalizedQuery, type ReportRow } from '../model.js';
import type { Account } from '../provider.js';
import { defineTool, type AnyToolDefinition } from './registry.js';

const dateRangeSchema = z.union([
  z.enum(DATE_PRESETS),
  z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  }),
]);

export function builtinTools(): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'accounts_list',
      namespace: 'core',
      description: 'List connected ad accounts across all providers (or one provider).',
      input: z.object({
        provider: z.string().optional().describe('Limit to one provider id, e.g. "google".'),
      }),
      annotations: { readOnly: true },
      async handler(input, ctx) {
        const providers = input.provider ? [ctx.providers.get(input.provider)] : ctx.providers.list();
        const accounts: Account[] = [];
        for (const provider of providers) {
          accounts.push(...(await provider.listAccounts()));
        }
        return { accounts };
      },
    }),
    defineTool({
      name: 'report',
      namespace: 'core',
      description:
        'Cross-platform performance report with normalized metrics (spend, clicks, conversions, ROAS, ...). ' +
        'Rows are capped by `limit`; the response says when it truncated.',
      input: z.object({
        provider: z.string().optional().describe('Limit to one provider id.'),
        account_ids: z.array(z.string()).optional(),
        level: z.enum(ENTITY_LEVELS).default('campaign'),
        metrics: z.array(z.enum(METRICS)).min(1).default(['spend', 'impressions', 'clicks', 'conversions']),
        date_range: dateRangeSchema.default('last_7_days'),
        limit: z.number().int().positive().max(1000).default(100),
      }),
      annotations: { readOnly: true },
      async handler(input, ctx) {
        const providers = input.provider ? [ctx.providers.get(input.provider)] : ctx.providers.list();
        const query: NormalizedQuery = {
          accountIds: input.account_ids,
          level: input.level,
          metrics: input.metrics,
          dateRange: input.date_range,
          limit: input.limit,
        };
        const rows: ReportRow[] = [];
        for (const provider of providers) {
          const report = await provider.report(query);
          rows.push(...report.rows);
        }
        const truncated = rows.length > input.limit;
        return { rows: rows.slice(0, input.limit), truncated };
      },
    }),
  ];
}
