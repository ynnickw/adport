import { PageHeader } from '@/components/ui';
import { canAdminister, requireDashboardTenant } from '@/lib/cloud/dashboard';
import { oauthAdapter, oauthAvailability } from '@/lib/cloud/provider-oauth';
import { providerLabel } from '@/lib/cloud/providers';
import { listConnections } from '@/lib/cloud/repository';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';
import { ProviderConnections, type OAuthProviderView } from './provider-connections';

export const metadata = { title: 'Connections' };

const COPY: Record<OAuthProviderView['id'], string> = {
  google: 'Authorize the Google Ads accounts you can access through Google’s consent screen. Adport requests only the Google Ads scope and stores an encrypted refresh token for this organization.',
  meta: 'Sign in with Facebook Login for Business to grant ads_read and ads_management on the ad accounts you choose. The long-lived token is encrypted per organization.',
  tiktok: 'Authorize your TikTok for Business advertiser accounts through TikTok’s authorization page. The advertiser access token is encrypted per organization.',
  microsoft: 'Consent through the Microsoft identity platform with the Microsoft Advertising management scope. Adport supplies its own developer token; your refresh token is encrypted per organization.',
  reddit: 'Authorize through Reddit with the Ads read, edit, and data-deletion scopes. Adport stores an encrypted permanent refresh token for this organization.',
};

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const tenant = await requireDashboardTenant();
  const [connections, params] = await Promise.all([listConnections(tenant.organizationId), searchParams]);
  const availability = oauthAvailability();
  const oauthProviders: OAuthProviderView[] = OAUTH_PROVIDERS.map((id) => {
    const adapter = oauthAdapter(id);
    return { id, available: availability[id], flowLabel: adapter.flowLabel, scopes: adapter.scopes, copy: COPY[id], manualRevocationUrl: adapter.manualRevocationUrl };
  });
  return (
    <main className="page">
      <PageHeader
        eyebrow="Provider authority"
        title="Connections"
        description="Every platform is connected through its official OAuth consent using Adport-owned, reviewed applications. Tenants never paste application secrets; grants are encrypted per organization and revoked on disconnect."
      />
      <div className="stack" style={{ marginBottom: '0.9rem' }}>
        {params.connected ? <div className="callout success">{providerLabel(params.connected)} is connected and its accessible ad accounts were verified.</div> : null}
        {params.error ? <div className="error-callout" style={{ marginBottom: 0 }}>{params.error}</div> : null}
      </div>
      <ProviderConnections
        organizationId={tenant.organizationId}
        canManage={canAdminister(tenant)}
        connections={connections.map((connection) => ({
          provider: connection.provider,
          status: connection.status,
          externalLabel: connection.externalLabel,
          lastError: connection.lastError,
          connectedAt: connection.connectedAt.toISOString(),
          lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
        }))}
        oauthProviders={oauthProviders}
      />
      <section className="card" style={{ marginTop: '0.9rem' }}>
        <div className="card-head"><h2>How access is scoped</h2><span className="card-note">read-first · encrypted · revocable</span></div>
        <div className="card-body stack">
          <p className="subhead">Connecting a platform lists the ad accounts the authorizing user can already access; Adport cannot widen that set. Every read and guarded write in the dashboard, REST API, and remote MCP endpoint runs against those accounts only, with the organization&apos;s write policy enforced server-side.</p>
          <p className="subhead">Disconnecting revokes the grant at the provider where an API exists (Google, Meta, Reddit, TikTok) and deletes the encrypted token. Microsoft and Apple require removing Adport in the platform&apos;s own settings; the card tells you when that applies. See the <a href="https://adport.dev/privacy">privacy policy</a> for retention and deletion details.</p>
        </div>
      </section>
    </main>
  );
}
