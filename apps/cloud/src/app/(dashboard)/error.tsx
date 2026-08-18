'use client';

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Request failed safely</p>
          <h1>We could not load this view</h1>
          <p className="subhead">No provider operation was applied. Retry, or check the connection for this workspace.</p>
        </div>
      </div>
      <div className="error-callout">{error.message}</div>
      <button className="button" onClick={reset}>Try again</button>
    </main>
  );
}
