'use client';

import { Button } from '@/components/controls';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { analyticsPage } from '@/lib/analytics-pages';

export const ANALYTICS_PREFERENCES_EVENT = 'adport:analytics-preferences';

export function ProductAnalytics() {
  const pathname = usePathname();
  const [preference, setPreference] = useState<boolean | null | undefined>();
  const [configured, setConfigured] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const lastPage = useRef<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/analytics', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const value = await response.json() as { configured: boolean; enabled: boolean | null };
      setConfigured(value.configured);
      setPreference(value.enabled);
      setOpen(value.configured && value.enabled === null);
    }).catch(() => {});
    const show = () => setOpen(true);
    window.addEventListener(ANALYTICS_PREFERENCES_EVENT, show);
    return () => { controller.abort(); window.removeEventListener(ANALYTICS_PREFERENCES_EVENT, show); };
  }, []);

  useEffect(() => {
    const page = analyticsPage(pathname);
    if (!configured || !preference || !page || lastPage.current === page) return;
    lastPage.current = page;
    void fetch('/api/analytics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'page', page }) }).catch(() => {});
  }, [pathname, preference, configured]);

  async function save(enabled: boolean) {
    setSaving(true); setError('');
    try {
      const response = await fetch('/api/analytics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'preference', enabled }) });
      if (!response.ok) throw new Error();
      setPreference(enabled); setOpen(false);
    } catch { setError('Your choice could not be saved. Please try again.'); }
    finally { setSaving(false); }
  }

  if (!open) return pathname === '/onboarding' && preference !== undefined ? <Button type="button" className="analytics-preferences-link" onClick={() => setOpen(true)}>Privacy preferences</Button> : null;
  return (
    <section className="analytics-notice" role="region" aria-label="Optional product analytics">
      <h2>Help us improve Adport</h2>
      <p>Allow optional analytics to help us improve setup, useful features, and plans. PostHog receives pseudonymous dashboard and hosted-agent usage, role, plan, and outcome metadata. We exclude ad content, account details, credentials, and session recordings.</p>
      <p>You can change your choice in Privacy preferences. <a href="https://adport.dev/privacy#product-analytics" target="_blank" rel="noreferrer">Learn more</a></p>
      {!configured ? <p>Product analytics is currently disabled.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="analytics-notice-actions">
        <Button type="button" disabled={saving} onClick={() => void save(false)}>Decline analytics</Button>
        <Button type="button" disabled={saving || !configured} onClick={() => void save(true)}>Allow analytics</Button>
        {preference !== null && preference !== undefined ? <Button type="button" disabled={saving} onClick={() => setOpen(false)}>Close</Button> : null}
      </div>
    </section>
  );
}
