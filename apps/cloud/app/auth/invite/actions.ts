'use server';

import { selectProjectAction, type WorkspaceActionState } from '@/app/dashboard/projects/actions';
import { acceptMemberInvitation, previewMemberInvitation } from '@/lib/cloud/member-invitations';
import { PlanLimitError } from '@/lib/cloud/plan-limit';
import { enforceRateLimit } from '@/lib/cloud/repository';
import { HttpError } from '@/lib/http';
import { createClient } from '@/lib/supabase/server';

const invitationToken = /^[A-Za-z0-9_-]{43}$/;

async function confirmedRecipient() {
  const { data, error } = await (await createClient()).auth.getUser();
  return !error && data.user?.email && data.user.email_confirmed_at
    ? { userId: data.user.id, email: data.user.email } : undefined;
}

export async function readInvitationAction(token: string) {
  if (typeof token !== 'string' || !invitationToken.test(token)) return { status: 'unavailable' } as const;
  const recipient = await confirmedRecipient();
  if (!recipient) return { status: 'sign-in' } as const;
  const invite = await previewMemberInvitation(token, recipient);
  if (!invite) return { status: 'unavailable' } as const;
  return { status: 'ready', email: recipient.email, ...invite } as const;
}

export async function acceptInvitationAction(_state: WorkspaceActionState, form: FormData): Promise<WorkspaceActionState> {
  const token = form.get('token');
  if (typeof token !== 'string' || !invitationToken.test(token)) return { error: 'This invitation link is invalid.' };
  const recipient = await confirmedRecipient();
  if (!recipient) return { error: 'Sign in with the email address that received the invitation.' };
  let projectId: string;
  try {
    if (!await enforceRateLimit(`invitation-accept:${recipient.userId}`, 20)) throw new HttpError('Too many attempts. Try again in a minute.', 429);
    projectId = await acceptMemberInvitation(token, recipient);
  } catch (error) {
    if (error instanceof PlanLimitError) return { error: 'The organization has no editing seats available. Ask the sender to free a seat and try again.' };
    if (error instanceof HttpError && error.status !== 403) return { error: error.message };
    if (error instanceof HttpError) return { error: 'This invitation can no longer be accepted. Ask an organization owner to send a new one.' };
    console.error('Member invitation could not be accepted.');
    return { error: 'The invitation could not be accepted. Try again.' };
  }
  const selection = new FormData();
  selection.set('projectId', projectId);
  await selectProjectAction(selection);
  return { success: 'Invitation accepted.' };
}
