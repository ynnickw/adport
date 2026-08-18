'use server';

import { CredentialStore } from '@adport/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { clearSession, createDevSession, isLocalDevelopmentAuth, requireTenant } from '@/lib/auth';
import { discoverAndAllowAccounts, runWorkspaceAudit } from '@/lib/runtime';
import { getCloudStore } from '@/lib/store';

const supportedProviders = ['google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit'] as const;

export async function signInLocally(): Promise<void> {
  await createDevSession();
  redirect('/overview');
}

export async function signOut(): Promise<void> {
  await clearSession();
  redirect('/sign-in');
}

export async function connectDemo(): Promise<void> {
  const tenant = await requireTenant();
  const store = getCloudStore();
  store.connectDemo(tenant.workspaceId);
  await discoverAndAllowAccounts(tenant.workspaceId, 'mock');
  revalidatePath('/', 'layout');
  redirect('/overview');
}

export async function importLocalProvider(formData: FormData): Promise<void> {
  if (!isLocalDevelopmentAuth()) throw new Error('Local credential import is disabled outside development');
  const tenant = await requireTenant();
  const provider = String(formData.get('provider') ?? '');
  if (!supportedProviders.includes(provider as (typeof supportedProviders)[number])) throw new Error('Unsupported provider');
  const local = await new CredentialStore().get(provider);
  if (!local) throw new Error(`No local ${provider} credentials found. Run adport connect ${provider} first.`);
  await getCloudStore().credentials(tenant.workspaceId).set({ provider: local.provider, source: local.source, data: local.data });
  await discoverAndAllowAccounts(tenant.workspaceId, provider);
  revalidatePath('/', 'layout');
  redirect('/connections');
}

export async function disconnectProvider(formData: FormData): Promise<void> {
  const tenant = await requireTenant();
  const provider = String(formData.get('provider') ?? '');
  getCloudStore().deleteConnection(tenant.workspaceId, provider);
  revalidatePath('/', 'layout');
  redirect('/connections');
}

export async function runAudit(): Promise<void> {
  const tenant = await requireTenant();
  await runWorkspaceAudit(tenant.workspaceId);
  revalidatePath('/findings');
  redirect('/findings');
}
