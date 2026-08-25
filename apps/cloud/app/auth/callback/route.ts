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
    if (error) return NextResponse.redirect(new URL('/login?error=Authentication+link+is+invalid+or+expired', env().ADPORT_CLOUD_BASE_URL));
  }
  return NextResponse.redirect(new URL(returnTo, env().ADPORT_CLOUD_BASE_URL));
}
