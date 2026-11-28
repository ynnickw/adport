import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { db } from '@/lib/db';
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import type { CloudProvider, HostedOAuthGrant, StoredProviderCredential } from './types';

type TokenFetch = (url: string, init: { method: 'POST'; redirect: 'error'; signal: AbortSignal; headers: Record<string, string>; body: URLSearchParams }) => Promise<Pick<Response, 'ok' | 'json'>>;
const tokenResponse = z.object({
  token_type: z.string().refine(value => value.toLowerCase() === 'bearer'),
  access_token: z.string().min(1).max(32768), refresh_token: z.string().min(1).max(32768).optional(),
  expires_in: z.number().int().positive(), scope: z.string().optional(),
});

export async function requestGrantTokens(url: string, body: URLSearchParams, send: TokenFetch = fetch) {
  const response = await send(url, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(12_000),
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' } });
  if (!response.ok) throw new Error('The provider declined the OAuth token request. Reconnect to renew access.');
  const parsed = tokenResponse.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error('The provider returned an invalid OAuth token response.');
  const token = parsed.data;
  const refreshToken = token.refresh_token ?? body.get('refresh_token');
  if (!refreshToken) throw new Error('Enable refresh tokens for this OAuth application and reconnect.');
  return { accessToken: token.access_token, refreshToken, expiresAt: Math.floor(Date.now() / 1000) + token.expires_in,
    scopes: token.scope === undefined ? undefined : token.scope.split(/\s+/).filter(Boolean) };
}

type GrantTokens = Pick<HostedOAuthGrant, 'accessToken' | 'refreshToken' | 'expiresAt'>;

/** Lock before contacting a rotating-token issuer. Concurrent Cloud workers reuse the first refresh. */
export function hostedAccessToken(organizationId: string, provider: CloudProvider, initial: HostedOAuthGrant & { connectionId: string },
  refresh: (refreshToken: string) => Promise<GrantTokens>) {
  let tokens: GrantTokens = initial;
  const usable = (grant: GrantTokens) => grant.expiresAt > Date.now() / 1000 + 30;
  const aad = `connection:${organizationId}:${provider}`;
  return async (): Promise<string> => {
    if (usable(tokens)) return tokens.accessToken;
    tokens = await db().begin(async sql => {
      const [row] = await sql<Array<{ ciphertext: string }>>`
        select ciphertext from private.provider_credentials
        where organization_id = ${organizationId} and provider = ${provider} and connection_id = ${initial.connectionId} for update`;
      if (!row) throw new Error('This connection was removed.');
      const current = decryptSecret<StoredProviderCredential>(row.ciphertext, aad);
      if (!('grantId' in current) || current.grantId !== initial.grantId) throw new Error('The provider grant changed. Retry with the current connection.');
      if (usable(current)) return current;
      const { accessToken, refreshToken, expiresAt } = await refresh(current.refreshToken);
      const updated = { ...current, accessToken, refreshToken, expiresAt };
      await sql`update private.provider_credentials set ciphertext = ${encryptSecret(updated, aad)}, updated_at = now()
        where connection_id = ${initial.connectionId} and organization_id = ${organizationId} and provider = ${provider}`;
      return updated;
    });
    return tokens.accessToken;
  };
}

/** Lock the parent before the vault row, in the same order as reconnect. Revoke the latest rotated tokens. */
export function disconnectHostedConnection(organizationId: string, provider: CloudProvider,
  expected: StoredProviderCredential & { connectionId: string }, revoke?: (grant: StoredProviderCredential) => Promise<boolean>): Promise<boolean> {
  const { connectionId, ...previous } = expected;
  const changed = () => new Error('The connection changed while it was being disconnected. Please retry.');
  return db().begin(async sql => {
    const parent = await sql`select id from public.connections where id = ${connectionId}
      and organization_id = ${organizationId} and provider = ${provider} for update`;
    if (!parent.length) throw changed();
    const [row] = await sql<Array<{ ciphertext: string }>>`select ciphertext from private.provider_credentials
      where connection_id = ${connectionId} and organization_id = ${organizationId} and provider = ${provider} for update`;
    if (!row) throw changed();
    const current = decryptSecret<StoredProviderCredential>(row.ciphertext, 'connection:' + organizationId + ':' + provider);
    const same = 'grantId' in previous ? 'grantId' in current && current.grantId === previous.grantId : isDeepStrictEqual(current, previous);
    if (!same) throw changed();
    const revoked = revoke ? await revoke(current) : false;
    await sql`delete from public.connections where id = ${connectionId} and organization_id = ${organizationId} and provider = ${provider}`;
    return revoked;
  });
}
