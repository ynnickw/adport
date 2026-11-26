import { PageHeader } from '@/components/ui';
import { PrivacyPreferencesButton } from '@/components/privacy-preferences-button';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { analyticsPreference } from '@/lib/cloud/product-analytics';

export const metadata = { title: 'Preferences' };

export default async function PreferencesPage() {
  const tenant = await requireDashboardTenant();
  const enabled = await analyticsPreference(tenant.userId);
  return <main className="page">
    <PageHeader title="Preferences" />
    <section className="card"><div className="card-head preference-row"><div><h2>Product analytics</h2><span className="person-email">Optional · Applies across your projects</span></div>
      <div className="row-actions"><span className="status neutral">{enabled === null ? 'Not set' : enabled ? 'On' : 'Off'}</span><PrivacyPreferencesButton /></div>
    </div></section>
  </main>;
}
