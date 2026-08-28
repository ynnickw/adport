import 'server-only';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import type { TenantPrincipal } from './types';

export type FeedbackKind = 'support' | 'feedback' | 'bug';

export interface FeedbackMessage {
  id: string;
  kind: FeedbackKind;
  subject: string;
  message: string;
  pagePath: string | null;
  createdAt: Date;
}

export async function createFeedbackMessage(input: {
  principal: TenantPrincipal;
  kind: FeedbackKind;
  subject: string;
  message: string;
  pagePath?: string;
}): Promise<FeedbackMessage> {
  if (!input.principal.userId) throw new Error('Authentication required.');
  const recent = await db()<Array<{ count: number }>>`
    select count(*)::int as count from public.feedback
    where created_by = ${input.principal.userId} and created_at > now() - interval '10 minutes'
  `;
  if ((recent[0]?.count ?? 0) >= 5) throw new Error('Please wait a few minutes before sending another message.');
  const rows = await db()<FeedbackMessage[]>`
    insert into public.feedback (organization_id, created_by, kind, subject, message, page_path)
    values (${input.principal.organizationId}, ${input.principal.userId}, ${input.kind}, ${input.subject}, ${input.message}, ${input.pagePath ?? null})
    returning id, kind, subject, message, page_path, created_at
  `;
  return rows[0]!;
}

export async function setFeedbackNotification(
  id: string,
  input: { status: 'sent'; resendEmailId: string | null } | { status: 'failed'; error: string },
): Promise<void> {
  if (input.status === 'sent') {
    await db()`update public.feedback set notification_status = 'sent', resend_email_id = ${input.resendEmailId}, notification_error = null where id = ${id}`;
  } else {
    await db()`update public.feedback set notification_status = 'failed', notification_error = ${input.error.slice(0, 500)} where id = ${id}`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]!);
}

export async function notifySupportMessage(input: {
  feedback: FeedbackMessage;
  organizationName: string;
  senderName: string;
  senderEmail: string;
}): Promise<string | null> {
  const value = env();
  if (!value.RESEND_API_KEY || !value.SUPPORT_NOTIFICATION_EMAIL) throw new Error('Support email notifications are not configured.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${value.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'Adport Support <onboarding@resend.dev>',
      to: [value.SUPPORT_NOTIFICATION_EMAIL],
      reply_to: input.senderEmail,
      subject: `[Adport ${input.feedback.kind}] ${input.feedback.subject}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto"><p style="color:#ff6b00;font-weight:700">New Adport message</p><h1 style="font-size:22px">${escapeHtml(input.feedback.subject)}</h1><p style="white-space:pre-wrap;line-height:1.6">${escapeHtml(input.feedback.message)}</p><hr style="border:0;border-top:1px solid #eee"><p style="color:#666;font-size:13px">${escapeHtml(input.senderName)} · ${escapeHtml(input.senderEmail)}<br>${escapeHtml(input.organizationName)}${input.feedback.pagePath ? `<br>Page: ${escapeHtml(input.feedback.pagePath)}` : ''}<br>Feedback ID: ${input.feedback.id}</p></div>`,
    }),
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({})) as { id?: string; message?: string; error?: { message?: string } };
  if (!response.ok) throw new Error(body.message ?? body.error?.message ?? `Resend returned HTTP ${response.status}.`);
  return body.id ?? null;
}
