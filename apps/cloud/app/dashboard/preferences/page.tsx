import { PageHeader } from '@/components/ui';
import { DashboardLink } from '@/components/dashboard-navigation';
import { PrivacyPreferencesButton } from '@/components/privacy-preferences-button';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { analyticsPreference } from '@/lib/cloud/product-analytics';
import { ProfileEditor } from './profile-editor';

export const metadata = { title: 'Account settings' };

export default async function AccountSettingsPage() {
  const tenant = await requireDashboardTenant();
  const enabled = await analyticsPreference(tenant.userId);
  return <main className="page">
    <PageHeader title="Account settings" />
    <div className="account-settings-grid">
      <section className="card" aria-labelledby="account-profile-heading">
        <div className="card-head"><h2 id="account-profile-heading">Profile</h2></div>
        <ProfileEditor key={JSON.stringify([tenant.userId, tenant.userName, tenant.userAvatarUrl])}
          profile={{ displayName: tenant.userName, avatarUrl: tenant.userAvatarUrl }} />
      </section>
      <div className="stack">
        <section className="card" aria-labelledby="account-sign-in-heading">
          <div className="card-head"><h2 id="account-sign-in-heading">Sign-in</h2></div>
          <div className="card-body account-settings-body">
            <dl className="account-details">
              <dt>Sign-in email</dt>
              <dd>{tenant.email || 'No email on this account'}</dd>
            </dl>
            {tenant.email ? <DashboardLink className="button secondary small" href="/login/forgot-password?return_to=%2Fdashboard%2Fpreferences">Reset password</DashboardLink> : null}
          </div>
        </section>
        <section className="card" aria-labelledby="account-privacy-heading">
          <div className="card-head"><h2 id="account-privacy-heading">Privacy</h2></div>
          <div className="card-body account-settings-body">
            <div>
              <strong>Product analytics</strong>
              <p className="field-hint">Your choice applies across your Adport projects.</p>
            </div>
            <div className="row-actions">
              <span className="status neutral">{enabled === null ? 'Not set' : enabled ? 'On' : 'Off'}</span>
              <PrivacyPreferencesButton />
            </div>
          </div>
        </section>
      </div>
    </div>
  </main>;
}
