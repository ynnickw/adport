import 'server-only';
import { db } from '@/lib/db';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import type { CloudProvider, StoredProviderCredential } from './types';

const tokenKeys = ['accessToken', 'accessTokenSecret', 'refreshToken', 'expiresAt', 'refreshExpiresAt'] as const;
type TokenKey = typeof tokenKeys[number];
type TokenPatch = Partial<Record<TokenKey, string | number>>;

export function sameCredentialTokens(left: StoredProviderCredential, right: StoredProviderCredential): boolean {
  return tokenKeys.every(key => (left as TokenPatch)[key] === (right as TokenPatch)[key]);
}

/** Merge only tokens into the latest vault row, never a captured account scope. */
export async function rotateProviderTokens(input: {
  organizationId: string;
  provider: CloudProvider;
  connectionId: string;
  expected: StoredProviderCredential;
  tokens: TokenPatch;
}): Promise<void> {
  const aad = `connection:${input.organizationId}:${input.provider}`;
  await db().begin(async sql => {
    const rows = await sql<Array<{ ciphertext: string }>>`
      select ciphertext from private.provider_credentials
      where organization_id = ${input.organizationId} and provider = ${input.provider}
        and connection_id = ${input.connectionId}
      for update
    `;
    if (!rows[0]) throw new Error('The provider connection was removed during token refresh.');
    const latest = decryptSecret<StoredProviderCredential>(rows[0].ciphertext, aad);
    // Reauthorization can reuse a connection ID. Compare the old grant too;
    // losing a concurrent refresh must fail closed rather than restore old tokens.
    if (!sameCredentialTokens(latest, input.expected)) throw new Error('The provider grant changed during token refresh. Retry with the current connection.');
    const patch = Object.fromEntries(tokenKeys.filter(key => input.tokens[key] !== undefined).map(key => [key, input.tokens[key]]));
    await sql`
      update private.provider_credentials
      set ciphertext = ${encryptSecret({ ...latest, ...patch }, aad)}, updated_at = now()
      where organization_id = ${input.organizationId} and provider = ${input.provider}
        and connection_id = ${input.connectionId}
    `;
  });
}
