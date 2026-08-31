import 'server-only';
import { db } from '@/lib/db';

export const WAITLIST_CONSENT_VERSION = 'cloud-early-access-2026-08-31';

export async function joinCloudWaitlist(email: string): Promise<void> {
  // A duplicate deliberately has the same public response as a new signup.
  await db()`
    insert into private.cloud_waitlist (email, consent_version)
    values (${email}, ${WAITLIST_CONSENT_VERSION})
    on conflict (email) do nothing
  `;
}
