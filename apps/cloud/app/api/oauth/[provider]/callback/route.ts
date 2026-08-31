import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { GoogleAdsProvider } from '@adport/provider-google';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { oauthAdapter } from '@/lib/cloud/provider-oauth';
import { providerAllowedForOrganization } from '@/lib/cloud/provider-rollout';
import { describeProviderError } from '@/lib/cloud/provider-errors';
import {
  consumeOAuthTransaction,
  recordAudit,
  setConnectionVerification,
  updateProviderCredential,
  upsertProviderConnection,
} from '@/lib/cloud/repository';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { stageAccountSelection } from '@/lib/cloud/account-selection';
import { isOAuthProvider, type OAuthProvider } from '@/lib/cloud/types';
import { providerLabel } from '@/lib/cloud/providers';
import { env } from '@/lib/env';

/** Redirect within the configured public origin, never the inbound Host header. */
function back(_request: Request, path: string, query: Record<string, string>): NextResponse {
  const url = new URL(path, env().ADPORT_CLOUD_BASE_URL);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

/**
 * Complete the hosted OAuth flow: validate the one-time state, exchange the
 * code through the Adport-owned application, encrypt the tenant grant, and
 * verify it by listing the accessible ad accounts. Nothing from the provider
 * response is logged.
 */
export async function GET(request: Request, { params }: RouteContext<'/api/oauth/[provider]/callback'>) {
  const { provider: raw } = await params;
  if (!isOAuthProvider(raw)) return back(request, '/dashboard/connections', { error: 'Unknown OAuth provider.' });
  const provider: OAuthProvider = raw;
  const adapter = oauthAdapter(provider);
  const label = providerLabel(provider);
  const url = new URL(request.url);
  let returnPath = '/dashboard/connections';
  try {
    const stateParam = adapter.stateParam ?? 'state';
    const code = url.searchParams.get(adapter.codeParam);
    const state = url.searchParams.get(stateParam);
    const oauthError = url.searchParams.get('error') ?? url.searchParams.get('error_description') ?? (provider === 'x' ? url.searchParams.get('denied') : null);
    if (oauthError) throw new Error(`${label} authorization was not completed.`);
    if (!code || !state) throw new Error(`${label} OAuth callback is missing code or state.`);
    if (url.searchParams.getAll(adapter.codeParam).length !== 1 || url.searchParams.getAll(stateParam).length !== 1) throw new Error('Ambiguous OAuth callback parameters.');
    const initiatingPrincipal = await sessionPrincipal();
    const transaction = await consumeOAuthTransaction(provider, state, initiatingPrincipal.userId!);
    // Membership or role may have changed while the user was on the provider's
    // consent screen. Re-authorize against the transaction's organization
    // before storing a grant or constructing its tenant runtime.
    const principal = await sessionPrincipal(transaction.organizationId);
    if (!['owner', 'admin'].includes(principal.role ?? '')) {
      throw new Error('Owner or admin access is required.');
    }
    returnPath = transaction.returnPath;
    if (!providerAllowedForOrganization(provider, transaction.organizationId)) throw new Error('This provider is not enabled for this organization.');

    const credential = await adapter.exchange({ code, verifier: transaction.verifier, state });
    const selectionId = randomUUID();
    const connectionId = await upsertProviderConnection({
      organizationId: transaction.organizationId,
      userId: principal.userId!,
      provider,
      credential,
      externalLabel: `${label} grant pending verification`,
      scopes: adapter.scopes,
      selectionId,
    });

    try {
      const runtime = await createTenantRuntime(principal, { enforceAccountScope: false });
      const connectedProvider = runtime.ctx.providers.get(provider);
      const accounts = await connectedProvider.listAccounts();
      if (provider === 'google' && connectedProvider instanceof GoogleAdsProvider) {
        const googleCredential = credential as { refreshToken: string };
        await updateProviderCredential(transaction.organizationId, 'google', {
          refreshToken: googleCredential.refreshToken,
          loginCustomerIds: connectedProvider.loginCustomerIds(),
        }, selectionId);
      }
      await stageAccountSelection({
        principal,
        id: selectionId,
        connectionId,
        provider,
        accounts,
        returnPath,
      });
      await setConnectionVerification(transaction.organizationId, provider, {
        ok: true,
        label: 'Choose accounts to finish connecting',
      }, selectionId);
      await recordAudit(principal, {
        event: 'connected', provider, tool: 'oauth_connect', accountId: '*',
        summary: `Authorized ${label}; account selection required`,
      });
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'Provider credential verification failed',
        provider,
        error: describeProviderError(error, provider),
      }));
      await setConnectionVerification(transaction.organizationId, provider, {
        ok: false,
        error: describeProviderError(error, provider),
      }, selectionId);
      await recordAudit(principal, {
        event: 'note', provider, tool: 'oauth_verification', accountId: '*',
        summary: `Stored ${label} grant but account verification failed`,
      });
      return back(request, returnPath, { error: `${label} was authorized, but account verification failed. ${describeProviderError(error, provider)}` });
    }
    return back(request, '/account-selection', { selection_id: selectionId });
  } catch (error) {
    console.error(`${provider} OAuth callback failed:`, describeProviderError(error, provider));
    return back(request, returnPath, { error: `${label} connection failed. Please retry.` });
  }
}
