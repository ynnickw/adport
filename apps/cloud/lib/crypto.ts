import 'server-only';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';

function encryptionKey(): Buffer {
  const key = Buffer.from(env().ADPORT_CLOUD_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) throw new Error('ADPORT_CLOUD_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  return key;
}

export function encryptSecret(value: unknown, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret<T>(payload: string, aad: string): T {
  const [version, ivRaw, tagRaw, encryptedRaw] = payload.split('.');
  if (version !== 'v1' || !ivRaw || !tagRaw || !encryptedRaw) throw new Error('Unsupported encrypted secret format.');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  const cleartext = Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64url')), decipher.final()]);
  return JSON.parse(cleartext.toString('utf8')) as T;
}

export function digestState(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function digestApiKey(value: string): string {
  return createHmac('sha256', env().ADPORT_API_KEY_PEPPER).update(value).digest('hex');
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
