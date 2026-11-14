import { z } from 'zod';

/** Read-only tables shared by providers and host widgets; native data stays alongside them. */
export const planningViewSchema = z.object({
  title: z.string().min(1).max(240),
  columns: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]*$/), label: z.string().min(1).max(120) })).min(1).max(12),
  rows: z.array(z.record(z.string(), z.string().max(2000).nullable())).max(50_000),
  notes: z.array(z.string().max(4000)).max(30),
});
export type PlanningView = z.infer<typeof planningViewSchema>;
