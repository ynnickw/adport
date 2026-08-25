import { redirect } from 'next/navigation';
import { AuthScreen } from '@/components/auth-screen';
import { safeReturnPath } from '@/lib/return-path';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function HomePage({ searchParams }: { searchParams: Promise<{ mode?: string; error?: string; message?: string; return_to?: string }> }) {
  const { mode, error, message, return_to: returnTo } = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) redirect(safeReturnPath(returnTo ?? null));
  return <AuthScreen mode={mode === 'signup' ? 'signup' : 'signin'} error={error} message={message} returnTo={returnTo} />;
}
