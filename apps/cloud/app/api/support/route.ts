import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { createFeedbackMessage, notifySupportMessage, setFeedbackNotification } from '@/lib/cloud/support';
import { db } from '@/lib/db';
import { apiError, noStoreJson } from '@/lib/http';
import { createClient } from '@/lib/supabase/server';

const inputSchema = z.object({
  kind: z.enum(['support', 'feedback', 'bug']),
  subject: z.string().trim().min(3).max(160),
  message: z.string().trim().min(10).max(5000),
  pagePath: z.string().startsWith('/').max(500).optional(),
  website: z.string().max(0).optional(),
});

export async function POST(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    const principal = await sessionPrincipal();
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user?.email) throw new Error('Authentication required.');
    const organizationRows = await db()<Array<{ name: string }>>`
      select name from public.organizations where id = ${principal.organizationId} limit 1
    `;
    const feedback = await createFeedbackMessage({ principal, ...input });
    let notificationDelayed = false;
    try {
      const emailId = await notifySupportMessage({
        feedback,
        organizationName: organizationRows[0]?.name ?? 'Adport workspace',
        senderName: String(auth.user.user_metadata?.full_name ?? auth.user.email.split('@')[0]),
        senderEmail: auth.user.email,
      });
      await setFeedbackNotification(feedback.id, { status: 'sent', resendEmailId: emailId });
    } catch (error) {
      notificationDelayed = true;
      await setFeedbackNotification(feedback.id, { status: 'failed', error: error instanceof Error ? error.message : 'Notification failed.' });
      console.error(JSON.stringify({ level: 'error', message: 'Support notification failed', feedbackId: feedback.id }));
    }
    return noStoreJson({ id: feedback.id, notificationDelayed }, 201);
  } catch (error) {
    return apiError(error, error instanceof z.ZodError ? 400 : 403);
  }
}
