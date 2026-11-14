import { AdportError } from '../errors.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const resourcePatterns: Record<string, RegExp> = {
  google: /^customers\/\d+\/[A-Za-z]+\/[\d~]+$/,
  meta: /^\d+$/, tiktok: /^\d+$/, apple: /^\d+$/, microsoft: /^\d+$/, pinterest: /^\d+$/,
  snapchat: uuid, spotify: uuid, media: uuid,
  reddit: /^(?:\d+|t3_[a-z0-9]+)$/,
  linkedin: /^(?:[1-9]\d{0,18}|urn:li:(?:(?:sponsoredCampaign|sponsoredCampaignGroup|sponsoredCreative|ugcPost|share):\d+|(?:image|video|document):[A-Za-z0-9_-]+))$/,
  x: /^(?:[0-9a-z]{1,32}|\d+_\d+)$/,
  mock: /^(?:c|g|a)\d+$/,
};

/** Failure audits exclude messages, submitted values, receipts and capabilities. */
export function failureAuditDetails(provider: string, error: unknown) {
  const details = error instanceof AdportError && error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? error.details as Record<string, unknown> : {};
  const candidates = [...(Array.isArray(details.resource_ids) ? details.resource_ids.slice(0, 100) : []), ...(Array.isArray(details.resourceIds) ? details.resourceIds.slice(0, 100) : []), ...(typeof details.media_id === 'string' ? [details.media_id] : [])];
  const pattern = Object.hasOwn(resourcePatterns, provider) ? resourcePatterns[provider] : undefined;
  const resourceIds = [...new Set(candidates.filter((value): value is string => typeof value === 'string' && value.length <= 256 && !!pattern?.test(value)))].slice(0, 100);
  return { phase: 'apply_failed', outcome: 'UNCONFIRMED', ...(error instanceof AdportError ? { error_code: error.code } : {}), ...(resourceIds.length ? { resourceIds } : {}) };
}
