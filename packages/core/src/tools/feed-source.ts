import { isIP } from 'node:net';
import { z } from 'zod';

export const hostedFeedUrl = z.string().max(8192).refine(value => {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.$/, '');
    return url.protocol === 'https:' && host.includes('.') && isIP(host) === 0
      && !/\.(?:local|localhost|internal)$/i.test(host)
      && !url.username && !url.password && !url.search && !url.hash && !/[\s\x00-\x1f\x7f]/.test(value);
  } catch { return false; }
}, 'Use a public HTTPS feed URL without authentication, a query string, or a fragment')
  .describe('Public HTTPS feed URL without authentication, a query string, or a fragment.');
