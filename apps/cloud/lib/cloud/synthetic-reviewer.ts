import 'server-only';
import { env } from '@/lib/env';

/** Retired reviewer identities stay isolated; they must never inherit real credentials. */
export function isSyntheticReviewer(organizationId: string): boolean {
  return (env().ADPORT_SYNTHETIC_REVIEWER_ORGANIZATION_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean).includes(organizationId);
}
