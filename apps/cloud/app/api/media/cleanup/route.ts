import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { cleanupDeletedProjectMedia } from '@/lib/cloud/media';

export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = env().CRON_SECRET;
  if (!secret) return Response.json({ error: 'Media cleanup is not configured.' }, { status: 503 });
  const supplied = Buffer.from(request.headers.get('authorization') ?? ''), expected = Buffer.from(`Bearer ${secret}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  const result = await cleanupDeletedProjectMedia();
  return Response.json(result, { status: result.failed ? 500 : 200 });
}
