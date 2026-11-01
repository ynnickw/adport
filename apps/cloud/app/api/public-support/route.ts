import { z } from 'zod';
import { enforceRateLimit } from '@/lib/cloud/repository';
import { notifyWebsiteSupportMessage } from '@/lib/cloud/support';

export const runtime = 'nodejs';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  kind: z.enum(['support', 'feedback', 'bug']),
  message: z.string().trim().min(10).max(5000),
  pagePath: z.string().regex(/^\/(?!\/)[^?#\r\n]*$/).max(500).optional(),
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
  return Response.json(body, { status, headers: {
    'Cache-Control': 'no-store', 'Vary': 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    ...(status === 429 ? { 'Retry-After': '60' } : {}),
  } });
}

export function OPTIONS(request: Request): Response {
  const origin = allowedOrigin(request);
  if (!origin) return respond(request, { error: 'Origin not allowed.' }, 403);
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store', 'Vary': 'Origin',
  } });
}

export async function POST(request: Request): Promise<Response> {
  if (!allowedOrigin(request)) return respond(request, { error: 'Origin not allowed.' }, 403);
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return respond(request, { error: 'JSON required.' }, 415);
  const reader = request.body?.getReader();
  if (!reader) return respond(request, { error: 'Invalid message.' }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) { await reader.cancel(); return respond(request, { error: 'Message too large.' }, 413); }
      chunks.push(value);
    }
  } catch {
    return respond(request, { error: 'Invalid message.' }, 400);
  } finally { reader.releaseLock(); }
  let input;
  try { input = inputSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { return respond(request, { error: 'Invalid message.' }, 400); }
  if (!input.success) return respond(request, { error: 'Enter a valid email and a message between 10 and 5,000 characters.' }, 400);
  if (input.data.website) return respond(request, { ok: true });
  try {
    // Vercel supplies this header; generic forwarded headers remain untrusted.
    const address = process.env.VERCEL === '1'
      ? request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
      : 'non-vercel';
    if (!await enforceRateLimit(`website-support:ip:${address}`, 5)
      || !await enforceRateLimit('website-support:global', 50)) return respond(request, { error: 'Too many messages. Please wait a minute and try again.' }, 429);
    await notifyWebsiteSupportMessage(input.data);
    return respond(request, { ok: true });
  } catch {
    console.error('Website support delivery failed.');
    return respond(request, { error: 'Your message could not be sent. Please try again or email yannick@adport.dev.' }, 503);
  }
}
