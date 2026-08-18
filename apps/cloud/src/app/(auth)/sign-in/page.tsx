import { SignIn } from '@clerk/nextjs';
import { currentTenant, isLocalDevelopmentAuth } from '@/lib/auth';
import { signInLocally } from '@/app/actions';
import { redirect } from 'next/navigation';
import { BrandLockup } from '@/components/logos';

export const metadata = { title: 'Sign in' };

export default async function SignInPage() {
  if (await currentTenant()) redirect('/overview');
  const clerk = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-bar">
          <div className="traffic" aria-hidden="true"><i /><i /><i /></div>
          <span>adport cloud — sign in</span>
        </div>
        <div className="auth-body">
          <BrandLockup sub="Control plane" />
          <h1>Operate ads with evidence.</h1>
          <p>Connect accounts, review normalized performance, and keep every proposed change behind the same policy gate.</p>
          {clerk ? <SignIn /> : isLocalDevelopmentAuth() ? (
            <form action={signInLocally}>
              <button className="button full" type="submit">Continue as Adport Local</button>
              <div className="local-note">Development-only signed session. Production fails closed without Clerk.</div>
            </form>
          ) : <div className="error-callout">Identity is not configured. Set the Clerk keys to enable sign-in.</div>}
        </div>
      </section>
    </main>
  );
}
