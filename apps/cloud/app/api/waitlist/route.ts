import { z } from 'zod';
import { enforceRateLimit } from '@/lib/cloud/repository';
import { joinCloudWaitlist } from '@/lib/cloud/waitlist';

export const runtime = 'nodejs';

const payloadSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  consent: z.literal(true),
  website: z.string().max(200).default(''),
}).strict();

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  if (['https://adport.dev', 'https://www.adport.dev', 'https://app.adport.dev'].includes(origin)) return origin;
  if (process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return origin;
  return null;
}

function respond(request: Request, body: unknown, status = 200): Response {
  const origin = allowedOrigin(request);
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
      ...(status === 429 ? { 'Retry-After': '60' } : {}),
    },
  });
}

export function OPTIONS(request: Request): Response {
  const origin = allowedOrigin(request);
  if (!origin) return respond(request, { error: 'Origin not allowed.' }, 403);
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  } });
}

export async function POST(request: Request): Promise<Response> {
  if (!allowedOrigin(request)) return respond(request, { error: 'Origin not allowed.' }, 403);
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
    return respond(request, { error: 'JSON required.' }, 415);
  }
  // Bound the streamed body too: Content-Length alone is controlled by the caller.
  const reader = request.body?.getReader();
  if (!reader) return respond(request, { error: 'Invalid signup.' }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        return respond(request, { error: 'Request too large.' }, 413);
      }
      chunks.push(value);
    }
  } catch {
    return respond(request, { error: 'Invalid signup.' }, 400);
  } finally {
    reader.releaseLock();
  }
  let payload;
  try {
    payload = payloadSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return respond(request, { error: 'Invalid signup.' }, 400);
  }
  if (!payload.success) return respond(request, { error: 'Enter a valid email and agree to the early-access email.' }, 400);
  if (payload.data.website) return respond(request, { ok: true });
  try {
    // Vercel overwrites this header at its edge. Other hosts share the fallback
    // bucket rather than trusting a caller-controlled X-Forwarded-For header.
    const address = process.env.VERCEL === '1'
      ? request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
      : 'non-vercel';
    if (!await enforceRateLimit(`waitlist:ip:${address}`, 5)
      || !await enforceRateLimit('waitlist:global', 100)) {
      return respond(request, { error: 'Too many attempts.' }, 429);
    }
    await joinCloudWaitlist(payload.data.email);
    return respond(request, { ok: true });
  } catch {
    // Never log the database exception: it can contain the submitted email.
    console.error('Cloud waitlist signup failed.');
    return respond(request, { error: 'Could not join. Please try again later.' }, 503);
  }
}
