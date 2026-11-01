import { timingSafeEqual } from 'node:crypto';
import { reconcileBillingSubscriptions } from '@/lib/cloud/billing';
import { env } from '@/lib/env';

export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = env().CRON_SECRET;
  if (!secret) return Response.json({ error: 'Billing reconciliation is not configured.' }, { status: 503 });
  const supplied = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  const result = await reconcileBillingSubscriptions();
  return Response.json(result, { status: result.failed ? 500 : 200 });
}
