import { AdportError } from '@adport/core';
import { providerLabel } from './providers';

const PROVIDER_PATTERN = /\b(google|meta|facebook|tiktok|apple|microsoft|reddit)\b/i;
const AUTH_PATTERN = /\b(401|403|invalid|expired|revoked|unauthori[sz]ed|malformed access token|code 190|40105|40102|invalid_grant)\b/i;
const HTTP_PATTERN = /HTTP\s+(\d{3})|\((\d{3})\)/;

/**
 * Turn a provider failure into text that is safe to show in the browser: no
 * echoed tokens, no CLI instructions, no raw upstream bodies. The full error
 * is still available server-side for logging.
 */
export function describeProviderError(error: unknown, fallbackProvider?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const providerMatch = raw.match(PROVIDER_PATTERN)?.[1]?.toLowerCase();
  const provider = providerMatch === 'facebook' ? 'meta' : providerMatch ?? fallbackProvider;
  const label = provider ? providerLabel(provider) : 'The provider';
  const status = raw.match(HTTP_PATTERN);
  const code = status?.[1] ?? status?.[2];
  if (AUTH_PATTERN.test(raw)) {
    return `${label} rejected the stored grant${code ? ` (HTTP ${code})` : ''}. It is invalid, expired, or revoked — open Connections and re-authorize ${label}.`;
  }
  if (error instanceof AdportError && error.code === 'PROVIDER_ERROR') {
    return `${label} request failed${code ? ` (HTTP ${code})` : ''}. Retry in a moment; if it persists, re-authorize ${label} in Connections.`;
  }
  if (/No ad providers/i.test(raw)) return 'No ad platform is connected yet.';
  return `${label} read failed${code ? ` (HTTP ${code})` : ''}. Retry in a moment.`;
}
