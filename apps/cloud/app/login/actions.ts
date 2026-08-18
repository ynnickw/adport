'use server';

import { redirect } from 'next/navigation';
import { env } from '@/lib/env';
import { createClient } from '@/lib/supabase/server';

function credentials(formData: FormData, mode: 'signin' | 'signup') {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || password.length < 12) {
    redirect(`/login?${mode === 'signup' ? 'mode=signup&' : ''}error=Use+a+valid+email+and+a+password+of+at+least+12+characters`);
  }
  return { email, password };
}

export async function signIn(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(credentials(formData, 'signin'));
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect('/dashboard');
}

export async function signUp(formData: FormData) {
  const supabase = await createClient();
  const input = credentials(formData, 'signup');
  const displayName = String(formData.get('display_name') ?? '').trim();
  const { data, error } = await supabase.auth.signUp({
    ...input,
    options: {
      data: { full_name: displayName || input.email.split('@')[0] },
      emailRedirectTo: `${env().ADPORT_CLOUD_BASE_URL}/auth/callback`,
    },
  });
  if (error) redirect(`/login?mode=signup&error=${encodeURIComponent(error.message)}`);
  if (data.session) redirect('/dashboard');
  redirect('/login?message=Check+your+email+to+confirm+your+account');
}
