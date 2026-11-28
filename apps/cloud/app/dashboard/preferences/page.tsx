import { PageHeader } from '@/components/ui';
import { DashboardLink } from '@/components/dashboard-navigation';
import { InfoTooltip } from '@/components/info-tooltip';
import { PrivacyPreferencesButton } from '@/components/privacy-preferences-button';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { analyticsPreference } from '@/lib/cloud/product-analytics';
import { ProfileEditor } from './profile-editor';

export const metadata = { title: 'Account settings' };

export default async function AccountSettingsPage() {
  const tenant = await requireDashboardTenant();
  const enabled = await analyticsPreference(tenant.userId);
  return <main className="page settings-page">
    <PageHeader title="Account settings" />
    <section className="settings-section" aria-labelledby="account-profile-heading">
      <div className="settings-section-head"><h2 id="account-profile-heading">Profile <InfoTooltip label="About your profile">Your name and photo appear in team lists and member search.</InfoTooltip></h2></div>
      <ProfileEditor key={JSON.stringify([tenant.userId, tenant.userName, tenant.userAvatarUrl])}
        profile={{ displayName: tenant.userName, avatarUrl: tenant.userAvatarUrl }} />
    </section>
    <section className="settings-section" aria-labelledby="account-sign-in-heading">
      <div className="settings-section-head"><h2 id="account-sign-in-heading">Sign-in</h2></div>
      <div className="settings-row">
        <dl className="settings-row-copy account-details">
          <dt>Sign-in email</dt>
          <dd className="settings-note">{tenant.email || 'No email on this account'}</dd>
        </dl>
        {tenant.email ? <DashboardLink className="button secondary small" href="/login/forgot-password?return_to=%2Fdashboard%2Fpreferences">Reset password</DashboardLink> : null}
      </div>
    </section>
    <section className="settings-section" aria-labelledby="account-privacy-heading">
      <div className="settings-section-head"><h2 id="account-privacy-heading">Privacy</h2></div>
      <div className="settings-row">
        <div className="settings-row-copy">
          <strong className="settings-inline-label">Product analytics <InfoTooltip label="About product analytics">Your choice applies across your Adport projects.</InfoTooltip></strong>
          <p className="settings-note">{enabled === null ? 'Not set' : enabled ? 'On' : 'Off'}</p>
        </div>
        <PrivacyPreferencesButton />
      </div>
    </section>
  </main>;
}
