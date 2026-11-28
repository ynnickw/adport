import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';
import { pendingInvitationRedirectUrl } from '@/lib/invitations';
import { createAdminClient } from '@/lib/supabase/admin';

export async function sendMemberInvitationEmail(email: string, token: string, recipientUserId: string | null): Promise<string> {
  const config = env();
  const redirectTo = pendingInvitationRedirectUrl(config.ADPORT_CLOUD_BASE_URL, token);
  if (!recipientUserId) {
    const { data, error } = await createAdminClient().auth.admin.inviteUserByEmail(email, { redirectTo });
    if (error || !data.user) throw new HttpError('The invitation email could not be sent. Try again in a minute.', 502);
    return data.user.id;
  }

  // The invitee opens the link in their own browser, so the sender's PKCE verifier cannot be used.
  const supabase = createClient(config.NEXT_PUBLIC_SUPABASE_URL, config.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { flowType: 'implicit', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } });
  if (error) throw new HttpError('The invitation email could not be sent. Try again in a minute.', 502);
  return recipientUserId;
}
