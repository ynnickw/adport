'use server';

import { redirect } from 'next/navigation';
import { env } from '@/lib/env';
import { safeReturnPath } from '@/lib/return-path';
import { createClient } from '@/lib/supabase/server';

const socialProviders = new Set(['google', 'github']);

function credentials(formData: FormData, mode: 'signin' | 'signup') {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || password.length < 12) {
    const query = new URLSearchParams({ error: 'Use a valid email and a password of at least 12 characters' });
    if (mode === 'signup') query.set('mode', 'signup');
    const returnTo = safeReturnPath(formData.get('return_to'));
    if (returnTo !== '/dashboard') query.set('return_to', returnTo);
    redirect(`/login?${query}`);
  }
  return { email, password };
}

export async function signIn(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(credentials(formData, 'signin'));
  if (error) {
    const query = new URLSearchParams({ error: error.message });
    const returnTo = safeReturnPath(formData.get('return_to'));
    if (returnTo !== '/dashboard') query.set('return_to', returnTo);
    redirect(`/login?${query}`);
  }
  redirect(safeReturnPath(formData.get('return_to')));
}

export async function signUp(formData: FormData) {
  const supabase = await createClient();
  const input = credentials(formData, 'signup');
  const displayName = String(formData.get('display_name') ?? '').trim();
  const returnTo = safeReturnPath(formData.get('return_to'));
  const { data, error } = await supabase.auth.signUp({
    ...input,
    options: {
      data: { full_name: displayName || input.email.split('@')[0] },
      emailRedirectTo: `${env().ADPORT_CLOUD_BASE_URL}/auth/callback${returnTo === '/dashboard' ? '' : `?return_to=${encodeURIComponent(returnTo)}`}`,
    },
  });
  if (error) redirect(`/login?mode=signup&error=${encodeURIComponent(error.message)}`);
  if (data.session) redirect(returnTo);
  redirect('/login?message=Check+your+email+to+confirm+your+account');
}

export async function signInWithSocialProvider(formData: FormData) {
  const provider = String(formData.get('provider') ?? '');
  const returnTo = safeReturnPath(formData.get('return_to'));
  const mode = formData.get('mode') === 'signup' ? 'signup' : 'signin';
  if (!socialProviders.has(provider)) {
    const query = new URLSearchParams({ error: 'Unsupported sign-in provider' });
    if (mode === 'signup') query.set('mode', 'signup');
    if (returnTo !== '/dashboard') query.set('return_to', returnTo);
    redirect(`/login?${query}`);
  }

  const callback = new URL('/auth/callback', env().ADPORT_CLOUD_BASE_URL);
  if (returnTo !== '/dashboard') callback.searchParams.set('return_to', returnTo);

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: provider as 'google' | 'github',
    options: { redirectTo: callback.toString() },
  });
  if (error || !data.url) {
    const query = new URLSearchParams({ error: error?.message ?? 'Unable to start social sign-in' });
    if (mode === 'signup') query.set('mode', 'signup');
    if (returnTo !== '/dashboard') query.set('return_to', returnTo);
    redirect(`/login?${query}`);
  }
  redirect(data.url);
}
