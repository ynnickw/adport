import { z } from 'zod';
import { ANALYTICS_PAGES } from './analytics-pages';

const provider = z.enum(['google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x']);
const plan = z.enum(['reader', 'operator', 'premium', 'agency', 'enterprise']);
export const productEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('analytics_enabled') }).strict(),
  z.object({ event: z.literal('dashboard_viewed'), page: z.enum(ANALYTICS_PAGES) }).strict(),
  z.object({ event: z.literal('onboarding_progressed'), step: z.enum(['welcome', 'connect', 'accounts', 'agent', 'complete']), complete: z.boolean(), agent: z.enum(['chatgpt', 'codex', 'claude-code', 'claude', 'cursor', 'mcp']).optional() }).strict(),
  z.object({ event: z.literal('provider_connection_started'), provider }).strict(),
  z.object({ event: z.literal('provider_connection_verified'), provider }).strict(),
  z.object({ event: z.literal('provider_connection_failed'), provider, stage: z.enum(['authorization', 'verification']) }).strict(),
  z.object({ event: z.literal('account_access_changed'), provider, enabled: z.boolean() }).strict(),
  z.object({ event: z.literal('agent_connected'), agent: z.enum(['chatgpt', 'codex', 'claude', 'cursor', 'other']) }).strict(),
  z.object({ event: z.literal('tool_completed'), category: z.enum(['report', 'audit', 'read', 'write_preview', 'write_apply']), surface: z.enum(['dashboard', 'mcp', 'api']) }).strict(),
  z.object({ event: z.literal('tool_failed'), category: z.enum(['report', 'audit', 'read', 'write_preview', 'write_apply']), surface: z.enum(['dashboard', 'mcp', 'api']), reason: z.enum(['policy', 'invalid_input', 'provider', 'other']) }).strict(),
  z.object({ event: z.literal('organization_created') }).strict(),
  z.object({ event: z.literal('project_created') }).strict(),
  z.object({ event: z.literal('checkout_started'), target_plan: plan, interval: z.enum(['monthly', 'annual']) }).strict(),
  z.object({ event: z.literal('subscription_status_changed'), subscription_status: z.enum(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'canceled']), target_plan: plan }).strict(),
]);
export type ProductEvent = z.infer<typeof productEventSchema>;
