import { PageHeader } from '@/components/ui';
import { PrivacyPreferencesButton } from '@/components/privacy-preferences-button';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { analyticsPreference } from '@/lib/cloud/product-analytics';

export const metadata = { title: 'Preferences' };

export default async function PreferencesPage() {
  const tenant = await requireDashboardTenant();
  const enabled = await analyticsPreference(tenant.userId);
  return <main className="page">
    <PageHeader title="Preferences" description="Personal settings that follow you across your projects." />
    <section className="card"><div className="card-head"><h2>Privacy</h2><span className="status neutral">{enabled === null ? 'Not chosen yet' : enabled ? 'Optional analytics allowed' : 'Optional analytics declined'}</span></div>
      <div className="card-body stack"><p className="subhead">Choose whether to share optional product usage analytics to help improve Adport. Your choice applies to your account across all organizations and projects.</p><div><PrivacyPreferencesButton /></div><a className="inline-note" href="https://adport.dev/privacy#product-analytics" target="_blank" rel="noreferrer">Read the privacy policy ↗</a></div>
    </section>
  </main>;
}
