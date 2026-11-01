import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from './database.types';
import { REQUEST_PATH_HEADER } from '@/lib/return-path';

export async function updateSession(request: NextRequest) {
  const next = () => {
    const headers = new Headers(request.headers);
    // Always overwrite the client header; return destinations come from the actual request.
    headers.set(REQUEST_PATH_HEADER, request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.next({ request: { headers } });
  };
  let response = next();
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet) {
          for (const cookie of cookiesToSet) request.cookies.set(cookie.name, cookie.value);
          response = next();
          for (const cookie of cookiesToSet) response.cookies.set(cookie.name, cookie.value, cookie.options);
        },
      },
    },
  );
  await supabase.auth.getUser();
  return response;
}
