export interface TenantPrincipal {
  organizationId: string;
  userId?: string;
  apiKeyId?: string;
  role?: 'owner' | 'admin' | 'member' | 'viewer';
  scopes: string[];
}

export interface StoredGoogleCredential {
  refreshToken: string;
  loginCustomerId?: string;
}

export interface StoredMetaCredential {
  accessToken: string;
  appId?: string;
  appSecret?: string;
}

export interface StoredTikTokCredential {
  accessToken: string;
  appId: string;
  secret: string;
  sandbox?: boolean;
}

export interface StoredMicrosoftCredential {
  developerToken: string;
  clientId: string;
  refreshToken: string;
  clientSecret?: string;
  sandbox?: boolean;
}

export interface StoredRedditCredential {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  userAgent: string;
}

export interface StoredAppleCredential {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKeyPem: string;
}

export interface ProviderCredentialMap {
  google: StoredGoogleCredential;
  meta: StoredMetaCredential;
  tiktok: StoredTikTokCredential;
  microsoft: StoredMicrosoftCredential;
  reddit: StoredRedditCredential;
  apple: StoredAppleCredential;
}

export type CloudProvider = keyof ProviderCredentialMap;
export type StoredProviderCredential = ProviderCredentialMap[CloudProvider];
