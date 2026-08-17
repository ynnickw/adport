'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

function credentials(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || password.length < 12) redirect('/login?error=Use+a+valid+email+and+a+12-character+password');
  return { email, password };
}

export async function signIn(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(credentials(formData));
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect('/dashboard');
}

export async function signUp(formData: FormData) {
  const supabase = await createClient();
  const input = credentials(formData);
  const displayName = String(formData.get('display_name') ?? '').trim();
  const { error } = await supabase.auth.signUp({
    ...input,
    options: { data: { full_name: displayName || input.email.split('@')[0] } },
  });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect('/dashboard');
}
