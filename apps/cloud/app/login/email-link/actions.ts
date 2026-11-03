'use server';

import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { env } from '@/lib/env';
import { safeReturnPath } from '@/lib/return-path';

export interface EmailLinkState { sent?: boolean; error?: string; }

export async function requestEmailLink(_state: EmailLinkState, form: FormData): Promise<EmailLinkState> {
  const email = z.string().email().max(320).safeParse(String(form.get('email') ?? '').trim());
  if (!email.success) return { error: 'Enter a valid email address.' };
  const callback = new URL('/auth/callback', env().ADPORT_CLOUD_BASE_URL);
  callback.searchParams.set('return_to', safeReturnPath(form.get('return_to')));
  try {
    const { error } = await (await createClient()).auth.signInWithOtp({
      email: email.data,
      options: { shouldCreateUser: false, emailRedirectTo: callback.toString() },
    });
    // Invited users already have an account. Unknown addresses get the same
    // confirmation, without creating an account or revealing whether one exists.
    if (error && !['otp_disabled', 'user_not_found', 'signup_disabled'].includes(error.code ?? '')) {
      return { error: 'The sign-in email could not be sent. Wait a minute and try again.' };
    }
    return { sent: true };
  } catch {
    return { error: 'The sign-in email could not be sent. Check your connection and try again.' };
  }
}
