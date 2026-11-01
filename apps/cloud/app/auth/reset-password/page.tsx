import { BrandLockup } from '@/components/logos';
import { AuthFrame } from '@/components/ui';
import { safeReturnPath } from '@/lib/return-path';
import { ResetPasswordForm } from './reset-password-form';

export const metadata = { title: 'Choose a new password' };
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ return_to?: string; error?: string }> }) {
  const params = await searchParams;
  return <AuthFrame label="choose a new password"><BrandLockup size="large" /><h1>Choose a new password.</h1><ResetPasswordForm returnTo={safeReturnPath(params.return_to ?? null)} invalidLink={Boolean(params.error)} /></AuthFrame>;
}
