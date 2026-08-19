import Link from 'next/link';
import { BrandLockup } from '@/components/logos';
import { AuthFrame } from '@/components/ui';

export default function NotFound() {
  return (
    <AuthFrame label="404">
      <BrandLockup size="large" />
      <h1>Page not found</h1>
      <p>The route you requested does not exist. It may have moved, or the link may be out of date.</p>
      <Link className="button full" href="/dashboard">Return to overview</Link>
    </AuthFrame>
  );
}
