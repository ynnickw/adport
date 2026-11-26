'use client';

import { Button } from './controls';
import { ANALYTICS_PREFERENCES_EVENT } from './product-analytics';

export function PrivacyPreferencesButton() {
  return <Button type="button" className="button secondary small" aria-label="Manage product analytics" onClick={() => window.dispatchEvent(new Event(ANALYTICS_PREFERENCES_EVENT))}>Manage</Button>;
}
