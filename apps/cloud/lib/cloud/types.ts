export interface TenantPrincipal {
  organizationId: string;
  userId?: string;
  apiKeyId?: string;
  oauthTokenId?: string;
  clientId?: string;
  role?: 'owner' | 'admin' | 'member' | 'viewer';
  /** Scopes granted to the credential before dynamic plan and role checks. */
  grantedScopes?: string[];
  entitlement?: {
    planId: 'reader' | 'operator' | 'premium' | 'agency' | 'enterprise';
    planName: string;
    writeAccess: boolean;
  };
  scopes: string[];
}

/**
 * Credentials that Adport Cloud stores per tenant. OAuth-brokered providers
 * store only the user grant (token); the Adport-owned application identity
 * (client/app id, secret, developer token, user agent) lives in server
 * environment secrets and is injected when the tenant runtime is built.
 * Optional application fields remain for records created before the broker.
 */
export interface StoredGoogleCredential {
  refreshToken: string;
  /** Legacy single-manager setting retained for old encrypted records. */
  loginCustomerId?: string;
  /** Manager customer id keyed by the operating client customer id. */
  loginCustomerIds?: Record<string, string>;
}

export interface StoredMetaCredential {
  accessToken: string;
  appId?: string;
  appSecret?: string;
  /** Unix seconds when Meta reports the long-lived user token expires. */
  expiresAt?: number;
}

export interface StoredTikTokCredential {
  accessToken: string;
  appId?: string;
  secret?: string;
  sandbox?: boolean;
}

export interface StoredMicrosoftCredential {
  refreshToken: string;
  developerToken?: string;
  clientId?: string;
  clientSecret?: string;
  sandbox?: boolean;
}

export interface StoredRedditCredential {
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
  userAgent?: string;
}

/** Apple Ads service-provider authorization stores only the tenant grant. */
export interface StoredAppleCredential {
  refreshToken: string;
}

export interface ProviderCredentialMap {
  google: StoredGoogleCredential;
  meta: StoredMetaCredential;
  tiktok: StoredTikTokCredential;
  microsoft: StoredMicrosoftCredential;
  reddit: StoredRedditCredential;
  apple: StoredAppleCredential;
  snapchat: { refreshToken: string };
  spotify: { refreshToken: string };
  pinterest: { refreshToken: string };
  linkedin: { accessToken: string; expiresAt?: number; refreshToken?: string; refreshExpiresAt?: number };
  x: { accessToken: string; accessTokenSecret: string };
}

export type CloudProvider = keyof ProviderCredentialMap;
export type StoredProviderCredential = ProviderCredentialMap[CloudProvider];

export const CLOUD_PROVIDERS = ['google', 'meta', 'tiktok', 'microsoft', 'reddit', 'apple', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'] as const satisfies readonly CloudProvider[];
/** Providers whose connection is established through the Adport-owned OAuth application. */
export const OAUTH_PROVIDERS = CLOUD_PROVIDERS;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

export function isCloudProvider(value: string): value is CloudProvider {
  return (CLOUD_PROVIDERS as readonly string[]).includes(value);
}
