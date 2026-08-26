import Link from 'next/link';
import { signIn, signInWithSocialProvider, signUp } from '@/app/login/actions';
import { BrandLockup } from '@/components/logos';
import { AuthFrame } from '@/components/ui';

export interface AuthScreenProps {
  mode: 'signin' | 'signup';
  error?: string;
  message?: string;
  returnTo?: string;
}

export function AuthScreen({ mode, error, message, returnTo }: AuthScreenProps) {
  const signup = mode === 'signup';
  return (
    <AuthFrame label={signup ? 'create account' : 'sign in'}>
      <BrandLockup size="large" />
      <h1>{signup ? 'Create your workspace.' : 'Operate ads with evidence.'}</h1>
      <p>
        {signup
          ? 'One account, one organization. Connect ad platforms through their official OAuth consent, then keep every proposed change behind the same policy gate.'
          : 'Connect accounts, review normalized performance, and keep every proposed change behind the same policy gate.'}
      </p>
      {error ? <div className="error-callout" role="alert">{error}</div> : null}
      {message ? <div className="callout success" role="status">{message}</div> : null}
      <div className="social-auth" aria-label="Social sign in">
        <form action={signInWithSocialProvider}>
          <input type="hidden" name="provider" value="google" />
          <input type="hidden" name="mode" value={mode} />
          {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
          <button className="social-auth-button" type="submit">
            <GoogleIcon />
            Continue with Google
          </button>
        </form>
        <form action={signInWithSocialProvider}>
          <input type="hidden" name="provider" value="github" />
          <input type="hidden" name="mode" value={mode} />
          {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
          <button className="social-auth-button" type="submit">
            <GitHubIcon />
            Continue with GitHub
          </button>
        </form>
      </div>
      <div className="auth-divider"><span>or continue with email</span></div>
      <form className="form" action={signup ? signUp : signIn}>
        {returnTo ? <input type="hidden" name="return_to" value={returnTo} /> : null}
        {signup ? (
          <label className="field">
            <span>Name</span>
            <input name="display_name" autoComplete="name" placeholder="How your team sees you" />
          </label>
        ) : null}
        <label className="field">
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" required placeholder="you@company.com" />
        </label>
        <label className="field">
          <span>Password</span>
          <input name="password" type="password" minLength={12} autoComplete={signup ? 'new-password' : 'current-password'} required placeholder="At least 12 characters" />
        </label>
        <button className="button full" type="submit">{signup ? 'Create account' : 'Sign in'}</button>
      </form>
      <p className="auth-switch">
        {signup
          ? <>Already have an account? <Link href={returnTo ? `/login?return_to=${encodeURIComponent(returnTo)}` : '/'}>Sign in</Link></>
          : <>New to Adport? <Link href={returnTo ? `/login?mode=signup&return_to=${encodeURIComponent(returnTo)}` : '/?mode=signup'}>Create an account</Link></>}
      </p>
      <div className="auth-foot">
        <a href="https://adport.dev">adport.dev</a>
        <a href="https://adport.dev/privacy">privacy</a>
        <a href="https://adport.dev/terms">terms</a>
        <a href="https://github.com/ynnickw/adport">source</a>
      </div>
    </AuthFrame>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.32 2.98-7.41Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.98-.9 6.63-2.36l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.39 13.93A6 6 0 0 1 6.08 12c0-.67.11-1.32.31-1.93V7.45H3.04A10 10 0 0 0 2 12c0 1.61.38 3.14 1.04 4.55l3.35-2.62Z" />
      <path fill="#EA4335" d="M12 5.94c1.47 0 2.79.5 3.82 1.49l2.88-2.88A9.65 9.65 0 0 0 12 2a10 10 0 0 0-8.96 5.45l3.35 2.62C7.18 7.7 9.39 5.94 12 5.94Z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.4-1.27.74-1.56-2.57-.3-5.28-1.29-5.28-5.69 0-1.26.45-2.29 1.2-3.1-.12-.3-.52-1.48.11-3.07 0 0 .98-.31 3.16 1.19A10.9 10.9 0 0 1 12 6.09c.98 0 1.95.13 2.87.39 2.19-1.5 3.17-1.19 3.17-1.19.63 1.6.23 2.78.11 3.07.75.81 1.2 1.84 1.2 3.1 0 4.42-2.72 5.39-5.3 5.68.42.36.79 1.07.79 2.16v3.24c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}
