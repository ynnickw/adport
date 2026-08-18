import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCloudStore, type CloudIdentity, type CloudTenant } from './store';

const COOKIE = 'adport_cloud_session';
const DEV_USER: CloudIdentity = {
  userId: 'local-user',
  email: 'local@adport.dev',
  name: 'Adport Local',
};

function devAuthEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.ADPORT_CLOUD_DEV_AUTH !== 'false';
}

function cookieSecret(): string {
  const configured = process.env.ADPORT_CLOUD_SESSION_SECRET;
  if (configured) return configured;
  if (!devAuthEnabled()) throw new Error('ADPORT_CLOUD_SESSION_SECRET is required');
  return 'adport-local-session-development-only';
}

function sign(payload: string): string {
  return createHmac('sha256', cookieSecret()).update(payload).digest('base64url');
}

function devSessionValue(): string {
  const payload = Buffer.from(JSON.stringify({ sub: DEV_USER.userId, exp: Date.now() + 8 * 60 * 60_000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function validDevSession(value: string | undefined): boolean {
  if (!value || !devAuthEnabled()) return false;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return false;
  const expected = sign(payload);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string; exp?: number };
    return decoded.sub === DEV_USER.userId && typeof decoded.exp === 'number' && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

export async function createDevSession(): Promise<void> {
  if (!devAuthEnabled()) throw new Error('Development authentication is disabled');
  const jar = await cookies();
  jar.set(COOKIE, devSessionValue(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: 8 * 60 * 60,
  });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

async function identity(): Promise<CloudIdentity | undefined> {
  if (process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    const [{ auth, currentUser }] = await Promise.all([import('@clerk/nextjs/server')]);
    const session = await auth();
    if (!session.userId) return undefined;
    const user = await currentUser();
    return {
      userId: session.userId,
      email: user?.primaryEmailAddress?.emailAddress ?? `${session.userId}@unknown.invalid`,
      name: user?.fullName ?? user?.firstName ?? 'Adport user',
    };
  }
  const jar = await cookies();
  return validDevSession(jar.get(COOKIE)?.value) ? DEV_USER : undefined;
}

export async function currentTenant(): Promise<CloudTenant | undefined> {
  const user = await identity();
  return user ? getCloudStore().bootstrap(user) : undefined;
}

export async function requireTenant(): Promise<CloudTenant> {
  const tenant = await currentTenant();
  if (!tenant) redirect('/sign-in');
  return tenant;
}

export function isLocalDevelopmentAuth(): boolean {
  return devAuthEnabled();
}
