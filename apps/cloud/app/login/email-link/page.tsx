import Link from 'next/link';
import { BrandLockup } from '@/components/logos';
import { AuthFrame } from '@/components/ui';
import { safeReturnPath } from '@/lib/return-path';
import { EmailLinkForm } from './email-link-form';

export const metadata = { title: 'Sign in with an email link' };

export default async function EmailLinkPage({ searchParams }: { searchParams: Promise<{ return_to?: string }> }) {
  const params = await searchParams;
  const returnTo = safeReturnPath(params.return_to ?? null);
  return <AuthFrame label="email sign in"><BrandLockup size="large" /><h1>Sign in with an email link.</h1><p>Enter your Adport account email. We’ll send you a link to sign in without a password.</p><EmailLinkForm returnTo={returnTo} /><p className="auth-switch"><Link href={'/login?return_to=' + encodeURIComponent(returnTo)}>Back to sign in</Link></p></AuthFrame>;
}
