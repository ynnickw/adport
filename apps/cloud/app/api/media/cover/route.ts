import { env } from '@/lib/env';
import { mediaCoverSource } from '@/lib/cloud/media-cover';
import { pdfCover } from '@/lib/cloud/pdf-cover';

export const runtime = 'nodejs';
export const maxDuration = 30;
const MAX_BYTES = 50 * 1024 * 1024;
let active = 0;
const queue: Array<() => void> = [];

async function reserve() {
  if (active < 2) { active++; return; }
  if (queue.length >= 16) throw new Error('Preview queue full');
  await new Promise<void>((resolve, reject) => {
    const next = () => { clearTimeout(timer); active++; resolve(); };
    const timer = setTimeout(() => { const index = queue.indexOf(next); if (index >= 0) queue.splice(index, 1); reject(new Error('Preview queue timed out')); }, 8000);
    queue.push(next);
  });
}

function release() { active--; queue.shift()?.(); }
const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };

export async function GET(request: Request): Promise<Response> {
  let source: URL;
  try { source = mediaCoverSource(new URL(request.url).searchParams.get('source') ?? '', env().NEXT_PUBLIC_SUPABASE_URL); }
  catch { return new Response('Preview unavailable', { status: 404, headers }); }
  try { await reserve(); }
  catch { return new Response('Preview unavailable', { status: 503, headers }); }
  try {
    // The supplied Storage grant authorizes only these bytes. No service-role or
    // advertising credential is forwarded, and redirects cannot change the host.
    const response = await fetch(source, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw new Error('Source unavailable');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) throw new Error('Source too large');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(chunks);
    if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(bytes.subarray(0, 10).toString('ascii'))) throw new Error('Not a PDF');
    const image = await pdfCover(bytes);
    return new Response(new Uint8Array(image), { headers: { ...headers, 'content-type': 'image/png' } });
  } catch { return new Response('Preview unavailable', { status: 404, headers }); }
  finally { release(); }
}
