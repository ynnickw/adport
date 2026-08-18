import { CredentialStore } from '@adport/core';
import { connectDemo, disconnectProvider, importLocalProvider } from '@/app/actions';
import { PageHeader, Provider } from '@/components/ui';
import { requireTenant } from '@/lib/auth';
import { managedMetaOAuthConfigured } from '@/lib/meta-oauth';
import { getCloudStore } from '@/lib/store';

export const metadata = { title: 'Connections' };
export const dynamic = 'force-dynamic';

const availableProviders = ['google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit'] as const;

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ oauth?: string }> }) {
  const tenant = await requireTenant();
  const query = await searchParams;
  const connections = getCloudStore().listConnections(tenant.workspaceId);
  const local = await new CredentialStore().list();
  const importable = local.filter((record) => !connections.some((connection) => connection.provider === record.provider));
  return (
    <main className="page">
      <PageHeader eyebrow="Provider authority" title="Connections" description="Credentials are encrypted per workspace. Account discovery becomes the explicit access allowlist." />
      <div className="stack" style={{ marginBottom: '0.9rem' }}>
        <div className="callout">Local import exists only for development verification. Production onboarding uses Adport-owned, reviewed OAuth applications and hosted callbacks.</div>
        {query.oauth === 'connected' ? <div className="callout success">Meta is connected and its permitted ad accounts were discovered.</div> : null}
        {query.oauth && query.oauth !== 'connected' ? <div className="error-callout" style={{ marginBottom: 0 }}>Meta connection did not complete ({query.oauth}). No credential was stored.</div> : null}
      </div>
      <section className="connection-grid">
        {connections.map((connection) => (
          <article className="connection" key={connection.provider}>
            <div className="connection-top"><Provider name={connection.provider} /><span className="status">Connected</span></div>
            <dl className="connection-meta">
              <div><dt>Source</dt><dd>{connection.source}</dd></div>
              <div><dt>Accounts</dt><dd>{connection.accountCount} allowlisted</dd></div>
              <div><dt>Updated</dt><dd>{new Date(connection.updatedAt).toLocaleString()}</dd></div>
            </dl>
            <form action={disconnectProvider}>
              <input type="hidden" name="provider" value={connection.provider} />
              <button className="button danger" type="submit">Disconnect</button>
            </form>
          </article>
        ))}
        {!connections.some((connection) => connection.provider === 'mock') ? (
          <article className="connection">
            <div className="connection-top"><Provider name="mock" /><span className="status neutral">Local</span></div>
            <p className="connection-copy">Deterministic campaigns for validating reports, findings, previews, and dashboard states without touching an ad platform.</p>
            <form action={connectDemo}><button className="button" type="submit">Connect demo</button></form>
          </article>
        ) : null}
        {!connections.some((connection) => connection.provider === 'meta') ? (
          <article className="connection">
            <div className="connection-top"><Provider name="meta" /><span className="status warn">OAuth</span></div>
            <p className="connection-copy">Connect through Adport&apos;s hosted Meta app. The app secret remains server-side and the workspace token is encrypted.</p>
            {managedMetaOAuthConfigured() ? <a className="button" href="/api/oauth/meta/start">Connect Meta</a> : <button className="button" type="button" disabled>Awaiting app configuration</button>}
          </article>
        ) : null}
      </section>
      {availableProviders.some((provider) => !connections.some((connection) => connection.provider === provider)) ? (
        <section className="card" style={{ marginTop: '0.9rem' }}>
          <div className="card-head"><h2>Available providers</h2><span className="card-note">connect in a terminal, then import</span></div>
          <div className="provider-roster">
            {availableProviders.filter((provider) => provider !== 'meta' && !connections.some((connection) => connection.provider === provider)).map((provider) => (
              <div className="roster-item" key={provider}>
                <Provider name={provider} />
                <code className="roster-command"><span>$</span> adport connect {provider}</code>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <section className="card" style={{ marginTop: '0.9rem' }}>
        <div className="card-head"><h2>Import a local connection</h2><span className="card-note">development only</span></div>
        <div className="card-body">
          {importable.length === 0 ? <p className="subhead">No additional local credentials are available. Run <code>adport connect &lt;provider&gt;</code> in a terminal first.</p> : (
            <form className="form-row" action={importLocalProvider}>
              <select name="provider" aria-label="Local provider">
                {importable.map((record) => <option value={record.provider} key={record.provider}>{record.provider}</option>)}
              </select>
              <button className="button secondary" type="submit">Encrypt and import</button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
