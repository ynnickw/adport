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
  apple: 'Authorize Apple Ads through Adport’s Apple-approved service-provider flow. Apple returns a delegated refresh token for the accounts you approve; tenants never provide API keys or private keys.',
  snapchat: 'Connect Snapchat Marketing through its official consent screen. Testing is limited to the approved organization and the ad accounts you can access.',
  spotify: 'Connect Spotify Ads through its official consent screen. The developer application must be allowlisted for the Ads API before account verification can succeed.',
  pinterest: 'Connect Pinterest Ads with read and write permissions. Trial access is limited to eligible owner accounts; external access requires Standard approval.',
  linkedin: 'LinkedIn Advertising API Development Tier is enabled for Adport. Cloud connection testing must be enabled for your organization; broader access requires Standard Tier approval.',
  x: 'Connect your X ad accounts through OAuth 1.0a. Adport has Standard Ads API access; cloud onboarding is rolling out to enabled organizations.',
};

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const tenant = await requireDashboardTenant();
  const [connections, params] = await Promise.all([listConnections(tenant.organizationId), searchParams]);
  const availability = oauthAvailability(tenant.organizationId);
  const oauthProviders: OAuthProviderView[] = OAUTH_PROVIDERS.map((id) => {
    const adapter = oauthAdapter(id);
    return { id, available: availability[id], flowLabel: adapter.flowLabel, scopes: adapter.scopes, copy: COPY[id], manualRevocationUrl: adapter.manualRevocationUrl };
  });
  return (
    <main className="page">
      <PageHeader
        title="Connections"
        description="Connect each platform through its official OAuth consent. Grants are encrypted per organization and revoked on disconnect; you only ever get the ad accounts you can already access."
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
    </main>
  );
}
