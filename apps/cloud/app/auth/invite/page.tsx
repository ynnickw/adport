import { AuthFrame } from '@/components/ui';
import { BrandLockup } from '@/components/logos';
import { InviteAcceptance } from './invite-acceptance';
import { PendingInvitation } from './pending-invitation';

export const metadata = { title: 'Accept invitation' };

export default async function InvitationPage({ searchParams }: { searchParams: Promise<{ project_id?: string; token?: string }> }) {
  const params = await searchParams;
  return <AuthFrame label="accept invitation">
    <BrandLockup size="large" />
    {typeof params.token === 'string' ? <PendingInvitation key={params.token} token={params.token} />
      : <InviteAcceptance key={params.project_id ?? ''} projectId={params.project_id ?? ''} />}
  </AuthFrame>;
}
