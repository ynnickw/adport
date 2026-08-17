import { signIn, signUp } from './actions';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="auth-card">
      <h1>Sign in to Adport</h1>
      <p className="muted">Local development uses Supabase email/password authentication.</p>
      {error ? <p className="error">{error}</p> : null}
      <form className="stack">
        <label>Name<input name="display_name" autoComplete="name" /></label>
        <label>Email<input name="email" type="email" autoComplete="email" required /></label>
        <label>Password<input name="password" type="password" minLength={12} autoComplete="current-password" required /></label>
        <div className="actions">
          <button className="button" formAction={signIn}>Sign in</button>
          <button className="button secondary" formAction={signUp}>Create account</button>
        </div>
      </form>
    </main>
  );
}
