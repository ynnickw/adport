import { z } from 'zod';
import { AdportError } from '../errors.js';
import { ANALYTICS_PROVIDERS } from './catalog.js';
import { defineTool, type ToolContext } from './registry.js';

const source = z.object({
  provider: z.enum(ANALYTICS_PROVIDERS),
  account_id: z.string().trim().min(1).max(200).describe('Selected website or property ID from accounts_list.'),
}).strict();

export const acquisitionInput = source.extend({
  start_date: z.iso.date(), end_date: z.iso.date(),
  goal_ids: z.array(z.string().min(1).max(200)).min(1).max(20)
    .refine(ids => new Set(ids).size === ids.length, 'Goal IDs must be unique.').optional()
    .describe('IDs from analytics_goals. Selects conversion counts. Sessions and revenue cover the whole acquisition group.'),
  landing_page: z.boolean().default(false).describe('Also group by session entry page.'),
  limit: z.number().int().min(1).max(250).default(50),
  cursor: z.string().min(1).max(100).optional().describe('Continuation returned by the previous page of this report.'),
}).refine(i => i.start_date <= i.end_date, 'start_date must not be after end_date.');

const goal = z.object({ id: z.string(), name: z.string(), counting_method: z.string().optional() });
const goalsOutput = z.object({ provider: z.string(), account_id: z.string(), goals: z.array(goal) });
const counts = z.number().nonnegative().nullable();
export const acquisitionRow = z.object({
  dimensions: z.object({ source: z.string().nullable(), medium: z.string().nullable(), campaign: z.string().nullable(), landing_page: z.string().nullable().optional() }),
  metrics: z.object({ sessions: counts, conversions: counts, revenue: z.number().nullable() }),
  goal_counts: z.record(z.string(), counts).optional(),
});
const acquisitionOutput = z.object({
  provider: z.string(), account_id: z.string(),
  date_range: z.object({ start: z.string(), end: z.string(), timezone: z.string().nullable() }),
  currency: z.string().nullable(), attribution: z.string(), revenue_basis: z.string(),
  rows: z.array(acquisitionRow), next_cursor: z.string().optional(), notes: z.array(z.string()),
});

export type AnalyticsGoal = z.infer<typeof goal>;
export type AcquisitionRow = z.infer<typeof acquisitionRow>;
export type AcquisitionQuery = Omit<z.infer<typeof acquisitionInput>, 'provider'>;
export type AcquisitionReport = Omit<z.infer<typeof acquisitionOutput>, 'provider' | 'account_id'>;

/** A website analytics adapter supplies both aggregate reads. The registry owns their public schemas. */
export interface AcquisitionAnalytics {
  listGoals(accountId: string): Promise<AnalyticsGoal[]>;
  acquisitionReport(query: AcquisitionQuery): Promise<AcquisitionReport>;
}

function adapter(ctx: ToolContext, id: string): AcquisitionAnalytics {
  const analytics = ctx.providers.get(id).acquisitionAnalytics;
  if (!analytics) throw new AdportError('NOT_CONNECTED', 'Website analytics is unavailable for the selected source.');
  return analytics;
}

export function analyticsTools(sources: readonly typeof ANALYTICS_PROVIDERS[number][] = ANALYTICS_PROVIDERS) {
  if (!sources.length) return [];
  const platform = { provider: z.enum(sources) };
  return [
    defineTool({ name: 'analytics_goals', namespace: 'analytics', sourceProviders: sources, input: source.safeExtend(platform), output: goalsOutput,
      description: 'List the selected site’s conversion goals and their IDs for analytics_acquisition_report.',
      annotations: { readOnly: true }, async handler({ provider, account_id }, ctx) {
        return { provider, account_id, goals: await adapter(ctx, provider).listGoals(account_id) };
      } }),
    defineTool({ name: 'analytics_acquisition_report', namespace: 'analytics', sourceProviders: sources, input: acquisitionInput.safeExtend(platform), output: acquisitionOutput,
      description: 'Read sessions, conversions and revenue by session source, medium and campaign, optionally by landing page, for an inclusive date range.',
      annotations: { readOnly: true }, pagination: { cursorInput: 'cursor' },
      async handler({ provider, ...query }, ctx) {
        return { provider, account_id: query.account_id, ...await adapter(ctx, provider).acquisitionReport(query) };
      } }),
  ];
}
