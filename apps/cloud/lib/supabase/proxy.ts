import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from './database.types';

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet) {
          for (const cookie of cookiesToSet) request.cookies.set(cookie.name, cookie.value);
          response = NextResponse.next({ request });
          for (const cookie of cookiesToSet) response.cookies.set(cookie.name, cookie.value, cookie.options);
        },
      },
    },
  );
  await supabase.auth.getUser();
  return response;
}
