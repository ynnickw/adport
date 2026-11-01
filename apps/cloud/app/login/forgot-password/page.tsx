import Link from 'next/link';
import { BrandLockup } from '@/components/logos';
import { AuthFrame } from '@/components/ui';
import { safeReturnPath } from '@/lib/return-path';
import { RecoveryRequestForm } from './recovery-request-form';

export const metadata = { title: 'Reset password' };
export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ return_to?: string }> }) {
  const params = await searchParams;
  const returnTo = safeReturnPath(params.return_to ?? null);
  return <AuthFrame label="reset password"><BrandLockup size="large" /><h1>Reset your password.</h1><p>We will email you a link to choose a new password.</p><RecoveryRequestForm returnTo={returnTo} /><p className="auth-switch"><Link href={'/login?return_to=' + encodeURIComponent(returnTo)}>Back to sign in</Link></p></AuthFrame>;
}
