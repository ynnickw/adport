import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { analyticsConfig, analyticsPreference, captureProductEvent, setAnalyticsPreference } from '@/lib/cloud/product-analytics';
import { ANALYTICS_PAGES } from '@/lib/analytics-pages';
import { enforceRateLimit } from '@/lib/cloud/repository';
import { env } from '@/lib/env';
import { HttpError, apiError, noStoreJson } from '@/lib/http';

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preference'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('page'), page: z.enum(ANALYTICS_PAGES) }).strict(),
]);

export async function GET() {
  try {
    const principal = await sessionPrincipal();
    return noStoreJson({ configured: Boolean(analyticsConfig()), enabled: await analyticsPreference(principal.userId!) });
  } catch { return noStoreJson({ error: 'Sign in to manage analytics.' }, 401); }
}

export async function POST(request: Request) {
  try {
    if (request.headers.get('origin') !== new URL(env().ADPORT_CLOUD_BASE_URL).origin) throw new HttpError('Invalid origin.', 403);
    const principal = await sessionPrincipal().catch(() => { throw new HttpError('Sign in to manage analytics.', 401); });
    const input = inputSchema.parse(await request.json());
    if (!(input.action === 'preference' && !input.enabled) && !await enforceRateLimit(`analytics:${principal.userId}`, 90)) throw new HttpError('Please try again shortly.', 429);
    if (input.action === 'preference') {
      await setAnalyticsPreference(principal.userId!, input.enabled);
      if (input.enabled) captureProductEvent(principal, { event: 'analytics_enabled' });
      return noStoreJson({ enabled: input.enabled });
    }
    captureProductEvent(principal, { event: 'dashboard_viewed', page: input.page });
    return noStoreJson({ accepted: true });
  } catch (error) { return apiError(error, error instanceof HttpError ? error.status : 400); }
}
