import { env } from '@/lib/env';

export function GET() {
  const token = env().OPENAI_APPS_CHALLENGE_TOKEN;
  if (!token) return new Response('Not found', { status: 404 });
  return new Response(token, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
