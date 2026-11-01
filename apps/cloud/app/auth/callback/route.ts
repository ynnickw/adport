import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { safeReturnPath } from '@/lib/return-path';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const returnTo = safeReturnPath(url.searchParams.get('return_to'));
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const target = new URL(returnTo, env().ADPORT_CLOUD_BASE_URL);
      if (target.pathname === '/auth/reset-password') {
        target.searchParams.set('error', 'invalid');
        return NextResponse.redirect(target);
      }
      const query = new URLSearchParams({ error: 'Authentication link is invalid or expired' });
      if (returnTo !== '/dashboard') query.set('return_to', returnTo);
      return NextResponse.redirect(new URL('/login?' + query, env().ADPORT_CLOUD_BASE_URL));
    }
  }
  return NextResponse.redirect(new URL(returnTo, env().ADPORT_CLOUD_BASE_URL));
}
