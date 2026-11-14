import { z } from 'zod';

const httpsUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'Expected an HTTPS URL without embedded credentials');
const landingUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
}, 'Expected an HTTP or HTTPS destination without embedded credentials');

export const creativeFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/).refine(key => !['account_id', 'project_id', 'pending_operation_id', 'constructor', 'prototype'].includes(key)),
  label: z.string(),
  type: z.enum(['text', 'text_list', 'url_list', 'select']),
  value: z.union([z.string(), z.array(z.string())]),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  max_length: z.number().int().positive().optional(),
});

export const creativeActionSchema = z.object({
  label: z.string(),
  tool: z.string().regex(/^[a-z][a-z0-9_]+$/),
  arguments: z.record(z.string(), z.unknown()).refine(args => !Object.hasOwn(args, 'pending_operation_id'), 'Creative actions must request a new preview'),
  fields: z.array(creativeFieldSchema),
}).superRefine((action, ctx) => {
  const keys = new Set<string>();
  for (const field of action.fields) {
    if (keys.has(field.key) || Object.hasOwn(action.arguments, field.key)) ctx.addIssue({ code: 'custom', path: ['fields'], message: 'Editable fields must be unique and cannot replace bound arguments' });
    keys.add(field.key);
  }
});

export const creativeSchema = z.object({
  id: z.string(), provider: z.string(), account_id: z.string(),
  name: z.string(), type: z.string(), status: z.string().optional(),
  campaign_id: z.string().optional(), ad_group_id: z.string().optional(),
  headlines: z.array(z.string()).default([]), descriptions: z.array(z.string()).default([]),
  landing_urls: z.array(landingUrl).default([]),
  media: z.array(z.object({ type: z.enum(['image', 'video', 'audio']), url: httpsUrl, alt: z.string().optional(), poster_url: httpsUrl.optional(), open_url: httpsUrl.optional() })).default([]),
  actions: z.array(creativeActionSchema).default([]),
}).superRefine((creative, ctx) => {
  if (creative.actions.some(action => action.arguments.account_id !== creative.account_id)) ctx.addIssue({ code: 'custom', path: ['actions'], message: 'Actions must remain bound to the displayed account' });
});

export const creativesOutput = z.object({
  creatives: z.array(creativeSchema),
  truncated: z.boolean(),
  next_cursor: z.string().optional(),
});

export type Creative = z.infer<typeof creativeSchema>;
export type CreativeAction = z.infer<typeof creativeActionSchema>;

/** A visual action is an ordinary write-tool invocation with no approval token. */
export function creativeStatusAction(tool: string, args: Record<string, unknown>, current: string, statuses: string[]): CreativeAction {
  return creativeActionSchema.parse({
    label: 'Change status', tool, arguments: args,
    fields: [{ key: 'status', label: 'Status', type: 'select', value: current,
      options: statuses.map(value => ({ label: value, value })) }],
  });
}
