'use server';

import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { env } from '@/lib/env';
import { safeReturnPath } from '@/lib/return-path';

export interface RecoveryRequestState { sent?: boolean; error?: string; }
export async function requestPasswordReset(_state: RecoveryRequestState, form: FormData): Promise<RecoveryRequestState> {
  const email = z.string().email().max(320).safeParse(String(form.get('email') ?? '').trim());
  if (!email.success) return { error: 'Enter a valid email address.' };
  const target = new URL('/auth/reset-password', env().ADPORT_CLOUD_BASE_URL);
  target.searchParams.set('return_to', safeReturnPath(form.get('return_to')));
  const callback = new URL('/auth/callback', env().ADPORT_CLOUD_BASE_URL);
  callback.searchParams.set('return_to', target.pathname + target.search);
  try {
    const { error } = await (await createClient()).auth.resetPasswordForEmail(email.data, { redirectTo: callback.toString() });
    if (error) return { error: 'The reset email could not be sent. Wait a minute and try again.' };
    // Same response for unknown addresses; do not reveal whether an account exists.
    return { sent: true };
  } catch { return { error: 'The reset email could not be sent. Check your connection and try again.' }; }
}
