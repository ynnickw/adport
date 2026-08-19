import Link from 'next/link';
import { signIn, signUp } from '@/app/login/actions';
import { BrandLockup } from '@/components/logos';
import { AuthFrame } from '@/components/ui';

export interface AuthScreenProps {
  mode: 'signin' | 'signup';
  error?: string;
  message?: string;
}

export function AuthScreen({ mode, error, message }: AuthScreenProps) {
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
      <form className="form" action={signup ? signUp : signIn}>
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
          ? <>Already have an account? <Link href="/">Sign in</Link></>
          : <>New to Adport? <Link href="/?mode=signup">Create an account</Link></>}
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
