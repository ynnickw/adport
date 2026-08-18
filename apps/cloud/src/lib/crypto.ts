import 'server-only';

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const DEV_KEY_MATERIAL = 'adport-cloud-development-key-not-for-production';

function encryptionKey(): Buffer {
  const configured = process.env.ADPORT_CLOUD_ENCRYPTION_KEY;
  if (configured) {
    const key = Buffer.from(configured, 'base64');
    if (key.length !== 32) throw new Error('ADPORT_CLOUD_ENCRYPTION_KEY must decode to exactly 32 bytes');
    return key;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ADPORT_CLOUD_ENCRYPTION_KEY is required in production');
  }
  return createHash('sha256').update(DEV_KEY_MATERIAL).digest();
}

export function encryptJson(value: unknown, workspaceId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(workspaceId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptJson<T>(encoded: string, workspaceId: string): T {
  const [version, ivRaw, tagRaw, ciphertextRaw] = encoded.split('.');
  if (version !== 'v1' || !ivRaw || !tagRaw || !ciphertextRaw) throw new Error('Unsupported encrypted credential payload');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64url'));
  decipher.setAAD(Buffer.from(workspaceId));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}
