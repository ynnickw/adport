'use client';

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="auth-page">
          <section className="auth-card">
            <div className="auth-bar">
              <div className="traffic" aria-hidden="true"><i /><i /><i /></div>
              <span>adport cloud — error</span>
            </div>
            <div className="auth-body">
              <h1>Something went wrong</h1>
              <p>The request failed safely. No provider operation was applied.</p>
              <button className="button full" onClick={reset}>Try again</button>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
