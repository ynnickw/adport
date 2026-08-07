import { createPrivateKey, sign } from 'node:crypto';

export interface ClientSecretInput {
  /** SEARCHADS.<uuid> */
  clientId: string;
  /** SEARCHADS.<uuid> — equals clientId for self-managed orgs. */
  teamId: string;
  /** keyId of the public key uploaded in the Apple Ads UI. */
  keyId: string;
  /** EC prime256v1 private key, PEM (.p8 contents). */
  privateKeyPem: string;
  /** Secret lifetime in seconds; Apple caps exp at iat + 180 days. */
  lifetimeSeconds?: number;
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

/**
 * Apple Ads client secret: a self-signed ES256 JWT (header {alg, kid}; claims
 * iss=teamId, sub=clientId, aud=https://appleid.apple.com, iat, exp≤iat+180d).
 * We mint a short-lived secret per token request instead of storing one.
 */
export function createClientSecret(input: ClientSecretInput, now = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const lifetime = Math.min(input.lifetimeSeconds ?? 3600, 180 * 86_400 - 60);
  const header = { alg: 'ES256', kid: input.keyId };
  const payload = {
    iss: input.teamId,
    iat,
    exp: iat + lifetime,
    aud: 'https://appleid.apple.com',
    sub: input.clientId,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = createPrivateKey(input.privateKeyPem);
  // JWS ES256 requires the raw r||s signature form, not ASN.1/DER.
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}
