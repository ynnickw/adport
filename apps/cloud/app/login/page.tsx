import { redirect } from 'next/navigation';
import { AuthScreen } from '@/components/auth-screen';
import { createClient } from '@/lib/supabase/server';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ mode?: string; error?: string; message?: string }> }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) redirect('/dashboard');
  const { mode, error, message } = await searchParams;
  return <AuthScreen mode={mode === 'signup' ? 'signup' : 'signin'} error={error} message={message} />;
}
