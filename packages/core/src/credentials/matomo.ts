import { z } from 'zod';
import { AdportError } from '../errors.js';

/** Normalized Matomo base URL: https origin plus optional sub-path, no trailing slash or index.php. */
export function normalizeMatomoUrl(value: string): string {
  const raw = value.trim();
  let url: URL;
  try { url = new URL(raw); } catch { throw new AdportError('INVALID_INPUT', 'MATOMO_URL must be an absolute https URL, e.g. https://example.matomo.cloud.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || raw.includes('?') || raw.includes('#')) {
    throw new AdportError('INVALID_INPUT', 'MATOMO_URL must be an https URL without credentials, query or fragment.');
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/index\.php$/i, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}
export const matomoBaseUrl = z.string().min(1).max(2048).transform((value, ctx) => {
  try { return normalizeMatomoUrl(value); }
  catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }); return z.NEVER; }
});
