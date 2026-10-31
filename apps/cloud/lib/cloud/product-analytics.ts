import 'server-only';
import { createHmac } from 'node:crypto';
import { after } from 'next/server';
import { db } from '@/lib/db';
import { productEventSchema, type ProductEvent } from '@/lib/analytics-events';
import type { TenantPrincipal } from './types';

export function analyticsConfig() {
  const { POSTHOG_ENABLED, POSTHOG_PROJECT_TOKEN: token, POSTHOG_HOST: host, POSTHOG_ID_SALT: salt, POSTHOG_ENVIRONMENT: environment } = process.env;
  if (POSTHOG_ENABLED !== 'true' || !token || !salt || salt.length < 32 || !host || !['production', 'staging', 'local'].includes(environment ?? '')) return undefined;
  // Exact ingestion origin from the verified PostHog project; never a fallback.
  if (!['https://eu.i.posthog.com', 'https://us.i.posthog.com'].includes(host)) return undefined;
  if (process.env.VERCEL_ENV && (process.env.VERCEL_ENV === 'production' ? environment !== 'production' : environment !== 'staging')) return undefined;
  return { token, host, salt, environment: environment! };
}

export function analyticsId(salt: string, kind: 'user' | 'organization' | 'project', id: string): string {
  return createHmac('sha256', salt).update(`${kind}:${id}`).digest('hex');
}

export async function analyticsPreference(userId: string): Promise<boolean | null> {
  const rows = await db()<Array<{ enabled: boolean }>>`select enabled from private.product_analytics_preferences where user_id = ${userId}`;
  return rows[0]?.enabled ?? null;
}

export async function setAnalyticsPreference(userId: string, enabled: boolean): Promise<void> {
  await db()`insert into private.product_analytics_preferences (user_id, enabled, notice_version)
    values (${userId}, ${enabled}, 1) on conflict (user_id) do update
    set enabled = excluded.enabled, notice_version = 1, updated_at = now()`;
}

/** Consent and membership are checked again at delivery, including hosted-agent calls. */
export async function deliverProductEvent(principal: Pick<TenantPrincipal, 'userId' | 'organizationId'>, input: ProductEvent, timestamp = new Date().toISOString(), insertId?: string): Promise<void> {
  try {
    const config = analyticsConfig();
    const parsed = productEventSchema.safeParse(input);
    if (!config || !principal.userId || !parsed.success) return;
    const excluded = [process.env.ADPORT_PROVIDER_TEST_ORGANIZATION_IDS, process.env.ADPORT_SYNTHETIC_REVIEWER_ORGANIZATION_IDS, process.env.POSTHOG_EXCLUDED_PROJECT_IDS]
      .flatMap(value => value?.split(',').map(id => id.trim()).filter(Boolean) ?? []);
    if (excluded.includes(principal.organizationId)) return;
    const rows = await db()<Array<{ organizationId: string; plan: string; role: string }>>`
      select project.organization_group_id as organization_id,
        case when subscription.status in ('active', 'trialing', 'past_due') then subscription.plan::text else 'reader' end as plan,
        membership.role
      from private.product_analytics_preferences preference
      join private.project_memberships membership on membership.user_id = preference.user_id
      join public.organizations project on project.id = membership.organization_id
      join public.organization_groups company on company.id = project.organization_group_id
      join public.organization_subscriptions subscription on subscription.organization_id = company.default_project_id
      where preference.user_id = ${principal.userId} and preference.enabled
        and project.id = ${principal.organizationId} and project.archived_at is null
      limit 1`;
    const context = rows[0];
    if (!context || excluded.includes(context.organizationId)) return;
    const { event, ...properties } = parsed.data;
    const response = await fetch(`${config.host}/i/v0/e/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: config.token, event: `adport_${event}`, timestamp,
        distinct_id: analyticsId(config.salt, 'user', principal.userId),
        properties: { ...properties, organization_key: analyticsId(config.salt, 'organization', context.organizationId),
          project_key: analyticsId(config.salt, 'project', principal.organizationId),
          plan: context.plan, role: context.role, environment: config.environment, schema_version: 1,
          $process_person_profile: false, $geoip_disable: true,
          ...(insertId ? { $insert_id: analyticsId(config.salt, 'project', `event:${insertId}`) } : {}),
        },
      }), signal: AbortSignal.timeout(2_000), cache: 'no-store', redirect: 'error',
    });
    if (!response.ok) console.warn('Product analytics delivery failed', { status: response.status });
    await response.body?.cancel();
  } catch {
    // Never log user data, event payloads, tokens, or provider error messages.
    console.warn('Product analytics delivery unavailable');
  }
}

export function captureProductEvent(principal: Pick<TenantPrincipal, 'userId' | 'organizationId'>, event: ProductEvent, insertId?: string): void {
  if (!analyticsConfig() || !principal.userId) return;
  const timestamp = new Date().toISOString();
  try { after(() => deliverProductEvent(principal, event, timestamp, insertId)); } catch { /* Non-request callers and analytics failures must not affect product work. */ }
}
