import { z } from 'zod';

// TikTok's product-set operator reference, doc1740673108747265, checked 2026-11-05.
const operator = z.enum(['EQUAL', 'NOT_EQUAL', 'GT', 'LT', 'GTE', 'LTE', 'CONTAIN', 'I_CONTAIN', 'EXCLUDE', 'I_EXCLUDE', 'WILDCARD', 'I_WILDCARD', 'NOT_WILDCARD', 'I_NOT_WILDCARD', 'PREFIX', 'I_PREFIX']);
const text = z.string().min(1).max(2048);
const scalar = z.union([text, z.number().finite().refine(value => !Number.isInteger(value) || Number.isSafeInteger(value), 'Use a string for integers beyond JavaScript’s safe range')]);
export const nativeProductSetConditions = z.record(z.string(), z.unknown()).refine(value => {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];let visited = 0;
  while (stack.length) {
    const item = stack.pop()!;if (++visited > 20_000 || item.depth > 16) return false;
    if (typeof item.value === 'number' && (!Number.isFinite(item.value) || Number.isInteger(item.value) && !Number.isSafeInteger(item.value))) return false;
    if (item.value && typeof item.value === 'object') for (const key in item.value) {
      if (!Object.hasOwn(item.value, key)) continue;
      if (visited + stack.length >= 20_000) return false;
      stack.push({ value: (item.value as Record<string, unknown>)[key], depth: item.depth + 1 });
    }
  }
  return true;
}, 'Native filter values exceed exact numeric or inspection bounds');
const condition = z.object({
  field: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/).max(128),
  operation: operator, value: z.union([scalar, z.array(scalar).min(1).max(1024)]),
}).strict().superRefine((row, ctx) => {
  const list = Array.isArray(row.value);
  if (['EQUAL', 'NOT_EQUAL', 'GT', 'LT', 'GTE', 'LTE'].includes(row.operation) && list) ctx.addIssue({ code: 'custom', path: ['value'], message: 'This operator requires a single value' });
  if (['CONTAIN', 'I_CONTAIN', 'EXCLUDE', 'I_EXCLUDE'].includes(row.operation) && !list) ctx.addIssue({ code: 'custom', path: ['value'], message: 'This operator requires a list of values' });
  if (/WILDCARD|PREFIX/.test(row.operation) && (list ? (row.value as Array<string | number>).some(value => typeof value !== 'string') : typeof row.value !== 'string')) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Substring and prefix operators require strings' });
});
const clauses = z.array(condition).min(1).max(1024);
export const productSetConditions = z.object({ and: clauses.optional(), or: clauses.optional() }).strict().superRefine((value, ctx) => {
  if (Number(value.and !== undefined) + Number(value.or !== undefined) !== 1) ctx.addIssue({ code: 'custom', message: 'Choose either an AND group or an OR group' });
  const total = [...(value.and ?? []), ...(value.or ?? [])].reduce((n, row) => n + (Array.isArray(row.value) ? row.value.length : 1), 0);
  if (total > 1024) ctx.addIssue({ code: 'custom', message: 'Adport limits the combined number of filter values to 1,024 to avoid native timeouts' });
});

const phrases: Record<z.infer<typeof operator>, string> = {
  EQUAL: 'equals', NOT_EQUAL: 'does not equal', GT: 'is greater than', LT: 'is less than', GTE: 'is at least', LTE: 'is at most',
  CONTAIN: 'matches any value', I_CONTAIN: 'matches any value (case insensitive)', EXCLUDE: 'excludes every value', I_EXCLUDE: 'excludes every value (case insensitive)',
  WILDCARD: 'contains', I_WILDCARD: 'contains (case insensitive)', NOT_WILDCARD: 'does not contain', I_NOT_WILDCARD: 'does not contain (case insensitive)', PREFIX: 'starts with', I_PREFIX: 'starts with (case insensitive)',
};
export function describeProductSetConditions(raw: unknown): string {
  const parsed = productSetConditions.safeParse(raw);
  if (!parsed.success) return JSON.stringify(raw);
  const value = parsed.data;
  return (value.and ? 'All conditions' : 'Any condition') + ':\n' + (value.and ?? value.or!).map(row => `${row.field.replace(/[_.]/g, ' ')} ${phrases[row.operation]} ${JSON.stringify(row.value)}`).join('\n');
}
