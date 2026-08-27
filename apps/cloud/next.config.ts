import type { NextConfig } from 'next';
import path from 'node:path';

export function buildContentSecurityPolicy(supabaseOrigin: string, allowOAuthRedirects = false, development = false): string {
  const formAction = allowOAuthRedirects
    ? "form-action 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*"
    : "form-action 'self'";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    // React development mode needs eval for source-mapped stacks; never allowed in production.
    development ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'",
    // The Next.js dev server streams HMR updates over a local websocket.
    development ? `connect-src 'self' ${supabaseOrigin} ws:` : `connect-src 'self' ${supabaseOrigin}`,
    formAction,
  ].join('; ');
}

const config: NextConfig = {
  output: process.env.VERCEL ? undefined : 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  outputFileTracingIncludes: {
    '/*': ['../../node_modules/.pnpm/@swc+helpers@0.5.23/node_modules/@swc/helpers/**/*'],
  },
  poweredByHeader: false,
  experimental: {
    serverActions: {
      bodySizeLimit: '1mb',
    },
  },
  async headers() {
    const supabaseOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL
      ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin
      : 'http://127.0.0.1:55321';
    const development = process.env.NODE_ENV === 'development';
    const contentSecurityPolicy = buildContentSecurityPolicy(supabaseOrigin, false, development);
    const oauthConsentContentSecurityPolicy = buildContentSecurityPolicy(supabaseOrigin, true, development);
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
        ],
      },
      {
        source: '/oauth/authorize',
        headers: [{ key: 'Content-Security-Policy', value: oauthConsentContentSecurityPolicy }],
      },
      { source: '/dashboard', headers: [{ key: 'Cache-Control', value: 'private, no-store, max-age=0' }] },
      { source: '/dashboard/:path*', headers: [{ key: 'Cache-Control', value: 'private, no-store, max-age=0' }] },
      { source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'private, no-store, max-age=0' }] },
      { source: '/mcp', headers: [{ key: 'Cache-Control', value: 'private, no-store, max-age=0' }] },
    ];
  },
};

export default config;
