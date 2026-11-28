import { captureProductEvent } from '@/lib/cloud/product-analytics';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { NextResponse } from 'next/server';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { createPkce } from '@/lib/cloud/google-oauth';
import { oauthAdapter } from '@/lib/cloud/provider-oauth';
import { providerAllowedForOrganization } from '@/lib/cloud/provider-rollout';
import { matomoApplication } from '@/lib/cloud/matomo-oauth';
import { loadProviderCredential, createOAuthTransaction } from '@/lib/cloud/repository';
import { isOAuthProvider } from '@/lib/cloud/types';
import { apiError, noStoreJson } from '@/lib/http';
import { safeReturnPath } from '@/lib/return-path';
import { popupDestination, popupReturnPath, validPopupId } from '@/lib/oauth-popup';
import { env } from '@/lib/env';

/**
 * Begin the hosted OAuth flow for a provider. The state is single-use, hashed
 * at rest, bound to the signed-in user and organization, and expires in ten
 * minutes. The PKCE verifier is encrypted with the same tenant binding.
 */
export async function GET(request: Request, { params }: RouteContext<'/api/oauth/[provider]/start'>) {
  const url = new URL(request.url);
  const popupId = url.searchParams.get('popup_id');
  function failure(error: unknown, status: number) {
    const returnTo = popupDestination(url.searchParams.get('return_to'));
    if (!validPopupId(popupId) && !returnTo) return apiError(error, status);
    const next = new URL(returnTo ?? '/dashboard/connections', env().ADPORT_CLOUD_BASE_URL);
    next.searchParams.set('error', 'Could not start authorization. Try again from this project.');
    return NextResponse.redirect(validPopupId(popupId) ? new URL(popupReturnPath(popupId, next.pathname + next.search), next.origin) : next);
  }
  try {
    const { provider } = await params;
    if (!isOAuthProvider(provider)) return failure(new Error('Unknown OAuth provider.'), 404);
    if (provider === 'matomo') return failure(new Error('Start from the Matomo instance form.'), 400);
    const dataManager = url.searchParams.get('data_manager') === '1';
    if (url.searchParams.has('data_manager') && (provider !== 'google' || url.searchParams.getAll('data_manager').length !== 1 || !dataManager)) return failure(new Error('Invalid Google Data Manager authorization option.'), 400);
    const redditConversions = url.searchParams.get('conversions') === '1';
    if (url.searchParams.has('conversions') && (provider !== 'reddit' || url.searchParams.getAll('conversions').length !== 1 || !redditConversions)) return failure(new Error('Invalid Reddit conversion-events authorization option.'), 400);
    const pinManagement = url.searchParams.get('pin_management') === '1';
    if (url.searchParams.has('pin_management') && (provider !== 'pinterest' || url.searchParams.getAll('pin_management').length !== 1 || !pinManagement)) return failure(new Error('Invalid Pinterest Pin management authorization option.'), 400);
    const secretPins = url.searchParams.get('secret_pins') === '1';
    if (url.searchParams.has('secret_pins') && (provider !== 'pinterest' || url.searchParams.getAll('secret_pins').length !== 1 || !secretPins)) return failure(new Error('Invalid Pinterest secret Pin authorization option.'), 400);
    const catalogManagement = url.searchParams.get('catalog_management') === '1';
    if (url.searchParams.has('catalog_management') && (provider !== 'pinterest' || url.searchParams.getAll('catalog_management').length !== 1 || !catalogManagement)) return failure(new Error('Invalid Pinterest catalog authorization option.'), 400);
    const principal = await sessionPrincipal(url.searchParams.get('organization_id') ?? undefined);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
    if (!providerAllowedForOrganization(provider, principal.organizationId)) return failure(new Error('This provider is not enabled for this organization.'), 403);
    const adapter = oauthAdapter(provider, { googleDataManager: dataManager, redditConversions, pinterestPinManagement: pinManagement, pinterestSecretPins: secretPins, pinterestCatalogManagement: catalogManagement });
    if (!adapter.configured()) return failure(new Error(`The hosted ${provider} application is not available yet.`), 503);
    const prepared = await adapter.prepare?.();
    const state = prepared?.state ?? randomBytes(32).toString('base64url');
    const pkce = createPkce();
    const returnPath = url.searchParams.has('return_to')
      ? safeReturnPath(url.searchParams.get('return_to'))
      : `/dashboard/accounts?select_provider=${provider}`;
    await createOAuthTransaction({
      organizationId: principal.organizationId,
      userId: principal.userId!,
      provider,
      state,
      verifier: prepared?.verifier ?? pkce.verifier,
      ...(dataManager ? { googleDataManager: true } : {}),
      ...(redditConversions ? { redditConversions: true } : {}),
      ...(pinManagement ? { pinterestPinManagement: true } : {}),
      ...(secretPins ? { pinterestSecretPins: true } : {}),
      ...(catalogManagement ? { pinterestCatalogManagement: true } : {}),
      returnPath: validPopupId(popupId) ? popupReturnPath(popupId, returnPath) : returnPath,
    });
    captureProductEvent(principal, { event: 'provider_connection_started', provider });
    return NextResponse.redirect(prepared?.authorizationUrl ?? adapter.authorizationUrl({ state, challenge: pkce.challenge }));
  } catch (error) {
    return failure(error, 401);
  }
}

const matomoStart = z.object({
  organization_id: z.string().uuid(), url: z.string().max(2048), return_to: z.string().max(2048).optional(),
  client_id: z.string().trim().min(1).max(512).optional(), client_secret: z.string().min(1).max(4096).optional(),
}).strict().refine(input => Boolean(input.client_id) === Boolean(input.client_secret));

/** Instance registrations are confidential. Receive them in a same-origin POST and bind them to the one-time transaction. */
export async function POST(request: Request, { params }: RouteContext<'/api/oauth/[provider]/start'>) {
  if ((await params).provider !== 'matomo') return noStoreJson({ error: 'Unsupported provider.' }, 405);
  if (request.headers.get('origin') !== new URL(env().ADPORT_CLOUD_BASE_URL).origin) return noStoreJson({ error: 'Same-origin request required.' }, 403);
  const raw = await request.text();
  if (raw.length > 12000) return noStoreJson({ error: 'Request is too large.' }, 413);
  let input: z.infer<typeof matomoStart>;
  try { input = matomoStart.parse(JSON.parse(raw)); } catch { return noStoreJson({ error: 'Enter the instance URL and both registration fields, or use a saved registration.' }, 400); }
  try {
    const principal = await sessionPrincipal(input.organization_id);
    if (!['owner', 'admin'].includes(principal.role ?? '') || !providerAllowedForOrganization('matomo', principal.organizationId)) return noStoreJson({ error: 'Project administration access is required.' }, 403);
    const previous = await loadProviderCredential(principal.organizationId, 'matomo');
    const app = matomoApplication(input.url, input.client_id && input.client_secret ? { clientId: input.client_id, clientSecret: input.client_secret } : undefined, previous);
    const state = randomBytes(32).toString('base64url');
    const pkce = createPkce();
    const redirect = oauthAdapter('matomo', { matomoApplication: app }).authorizationUrl({ state, challenge: pkce.challenge });
    await createOAuthTransaction({ organizationId: principal.organizationId, userId: principal.userId!, provider: 'matomo', state,
      verifier: pkce.verifier, matomoApplication: app, returnPath: safeReturnPath(input.return_to ?? '/dashboard/analytics') });
    return noStoreJson({ redirect });
  } catch {
    return noStoreJson({ error: 'Check the public HTTPS instance URL and its confidential OAuth client registration.' }, 400);
  }
}
