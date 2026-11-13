import { AdportError } from '@adport/core';

export interface LinkedInPaging { start: number; count: number; total?: number; links?: Array<{ rel: string; href?: string }> }

export function linkedinPageState<T>(result: { elements: T[]; paging?: LinkedInPaging }, start: number, count: number, resource: string) {
  const p = result.paging;
  if (result.elements.length > count || p && (p.start !== start || p.count > count || p.count < result.elements.length) || !p && start > 0) throw new AdportError('PROVIDER_ERROR', 'linkedin: measurement pagination returned an inconsistent offset or size');
  // Live conversion finders can return a negative signed total. Preserve it as
  // native metadata, never as a count or an empty-collection assertion.
  const total = p?.total !== undefined && p.total >= 0 ? p.total : undefined;
  const next = Boolean(p?.links?.some(link => link.rel === 'next')) || (total !== undefined ? start + result.elements.length < total : result.elements.length === (p?.count ?? count));
  if (next && (!result.elements.length || p?.count === 0) || total !== undefined && result.elements.length && start + result.elements.length > total) throw new AdportError('PROVIDER_ERROR', 'linkedin: measurement pagination did not advance or contradicted its total');
  let offset = start + (total === undefined ? result.elements.length : p?.count ?? count);
  for (const link of p?.links ?? []) if (link.rel === 'next' && link.href) {
    try {
      const url = new URL(link.href, `https://api.linkedin.com/rest/${resource}`), value = url.searchParams.get('start'), candidate = value && /^\d+$/.test(value) ? Number(value) : NaN;
      // Extract only a bounded numeric offset. The next request always rebuilds
      // its original account/campaign filters and never follows a returned URL.
      if (url.origin === 'https://api.linkedin.com' && url.pathname === `/rest/${resource}` && url.searchParams.getAll('start').length === 1 && Number.isSafeInteger(candidate) && candidate > start && candidate >= start + result.elements.length && candidate <= start + p!.count) offset = candidate;
    } catch { /* An untrusted link cannot change scope or request destination. */ }
  }
  return { truncated: next, complete: p ? start === 0 && !next : null, ...(next && p ? { next_start: offset } : {}), ...(!p ? { notes: ['Native paging metadata is absent; collection completeness is unknown and no continuation is invented.'] } : p.total !== undefined && p.total < 0 ? { notes: ['The native total is negative and is not a row count. Paging uses native links and returned segments.'] } : {}) };
}
