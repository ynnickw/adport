import Link from 'next/link';
import { BrandLockup } from '@/components/logos';

export default function NotFound() {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-bar">
          <div className="traffic" aria-hidden="true"><i /><i /><i /></div>
          <span>adport cloud — 404</span>
        </div>
        <div className="auth-body">
          <BrandLockup sub="Control plane" />
          <h1>Page not found</h1>
          <p>The cloud route you requested does not exist. It may have moved, or the link may be out of date.</p>
          <Link className="button full" href="/overview">Return to overview</Link>
        </div>
      </section>
    </main>
  );
}
