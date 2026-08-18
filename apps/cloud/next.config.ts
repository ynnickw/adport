import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  agentRules: false,
  transpilePackages: [
    '@adport/core',
    '@adport/provider-google',
    '@adport/provider-meta',
    '@adport/provider-tiktok',
    '@adport/provider-apple',
    '@adport/provider-microsoft',
    '@adport/provider-reddit',
  ],
};

export default nextConfig;
