import { Empty, PageHeader, Provider, formatDate, formatMoney } from '@/components/ui';
import { providerLabel } from '@/components/logos';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listPendingOperations, type PendingOperationRow } from '@/lib/cloud/repository';

export const metadata = { title: 'Approvals' };

function expiresIn(expiresAt: Date, now: number): string {
  const minutes = Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 60_000));
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

// Provider summaries count money in micros; show amounts the way people read them.
function readableSummary(summary: string, currency: string): string {
  const money = (micros: string) => formatMoney(Number(micros) / 1e6, currency);
  // Only numbers the summary labels as micros; IDs and counts stay untouched.
  return summary
    .replace(/(\d+) → (\d+) micros\b/g, (_, from: string, to: string) => `${money(from)} → ${money(to)}`)
    .replace(/(\d+) micros\b/g, (_, value: string) => money(value));
}

// One pending operation, drawn as the same preview ticket the adport.dev write-gate demo uses.
function Ticket({ operation, now }: { operation: PendingOperationRow; now: number }) {
  const preview = operation.preview;
  const delta = preview?.budgetDeltas?.[0];
  const currency = delta?.currency ?? 'USD';
  const change = delta?.fromMicros ? ((delta.toMicros - delta.fromMicros) / delta.fromMicros) * 100 : null;
  return (
    <article className="ticket" aria-labelledby={`ticket-${operation.id}`}>
      <header className="ticket-head">
        <span className="ticket-status"><i aria-hidden="true" />Preview, not applied</span>
        <Provider name={operation.provider} />
      </header>
      <h2 className="ticket-summary" id={`ticket-${operation.id}`} title={preview?.summary}>{preview ? readableSummary(preview.summary, currency) : operation.operation.tool}</h2>
      {delta ? (
        <p className="ticket-diff">
          {delta.fromMicros !== undefined ? <><s>{formatMoney(delta.fromMicros / 1e6, currency)}</s><span className="diff-arrow" aria-hidden="true" /><span className="sr-only">to</span></> : null}
          <strong>{formatMoney(delta.toMicros / 1e6, currency)}</strong>
          {change !== null ? <span className="diff-delta">{change >= 0 ? '+' : ''}{change.toFixed(1)}%</span> : null}
          <span className="diff-target">{delta.target}</span>
        </p>
      ) : null}
      <ul className="ticket-checks">
        {preview?.changes.map((line) => <li key={line}>{line}</li>)}
        {preview?.serverValidated ? <li>{providerLabel(operation.provider)} validated the request in dry run</li> : null}
      </ul>
      {preview?.coercions.length ? <p className="ticket-coercion">Changed by policy: {preview.coercions.join('; ')}</p> : null}
      <footer className="ticket-stub">
        <div className="ticket-token">
          <span>pending_operation_id</span>
          <code>{operation.id}</code>
        </div>
        <div className="ticket-ttl"><span>Expires in</span><strong title={formatDate(operation.expiresAt)}>{expiresIn(operation.expiresAt, now)}</strong></div>
        <p className="ticket-note">Runs only when the agent repeats <code>{operation.operation.tool}</code> with this token and identical arguments, for account {operation.operation.accountId}.</p>
      </footer>
    </article>
  );
}

export default async function ApprovalsPage() {
  const tenant = await requireDashboardTenant();
  const pending = await listPendingOperations(tenant.organizationId);
  const now = Date.now();
  return (
    <main className="page">
      <PageHeader title="Approvals" description="Previewed writes waiting for their exact second call. Each entry is hash-bound to its arguments and expires under the organization policy." />
      {pending.length === 0 ? (
        <section className="card">
          <Empty title="No operations awaiting approval" copy="When an agent previews a guarded write, its exact operation, preview, and expiry appear here until it is applied or expires." />
        </section>
      ) : (
        <section aria-label={`${pending.length} pending operations`}>
          <p className="ticket-count">{pending.length} awaiting review</p>
          <div className="ticket-grid">
            {pending.map((operation) => <Ticket key={operation.id} operation={operation} now={now} />)}
          </div>
        </section>
      )}
    </main>
  );
}
