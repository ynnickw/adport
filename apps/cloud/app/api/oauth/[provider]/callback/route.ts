import { NextResponse } from 'next/server';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { oauthAdapter } from '@/lib/cloud/provider-oauth';
import { consumeOAuthTransaction, recordAudit, setConnectionVerification, upsertProviderConnection } from '@/lib/cloud/repository';
import { createTenantRuntime } from '@/lib/cloud/runtime';
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
    const code = url.searchParams.get(adapter.codeParam) ?? url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error') ?? url.searchParams.get('error_description');
    if (oauthError) throw new Error(`${label} authorization was not completed.`);
    if (!code || !state) throw new Error(`${label} OAuth callback is missing code or state.`);
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

    const credential = await adapter.exchange({ code, verifier: transaction.verifier });
    await upsertProviderConnection({
      organizationId: transaction.organizationId,
      userId: principal.userId!,
      provider,
      credential,
      externalLabel: `${label} grant pending verification`,
      scopes: adapter.scopes,
    });

    try {
      const runtime = await createTenantRuntime(principal);
      const accounts = await runtime.ctx.providers.get(provider).listAccounts();
      await setConnectionVerification(transaction.organizationId, provider, {
        ok: true,
        label: `${accounts.length} accessible ${label} account(s)`,
        subject: accounts.map((account) => account.id).join(','),
      });
      await recordAudit(principal, {
        event: 'connected', provider, tool: 'oauth_connect', accountId: '*',
        summary: `Connected ${accounts.length} accessible ${label} account(s) through hosted OAuth`,
        details: { accountCount: accounts.length },
      });
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'Provider credential verification failed',
        provider,
        error: error instanceof Error ? error.message : 'unknown error',
      }));
      await setConnectionVerification(transaction.organizationId, provider, {
        ok: false,
        error: `${label} credential verification failed. Reconnect to retry, or disconnect to revoke access.`,
      });
      await recordAudit(principal, {
        event: 'note', provider, tool: 'oauth_verification', accountId: '*',
        summary: `Stored ${label} grant but account verification failed`,
      });
      return back(request, returnPath, { error: `${label} was authorized, but Adport could not list its ad accounts yet. Reconnect to retry.` });
    }
    return back(request, returnPath, { connected: provider });
  } catch (error) {
    console.error(`${provider} OAuth callback failed:`, error instanceof Error ? error.message : 'unknown error');
    return back(request, returnPath, { error: `${label} connection failed. Please retry.` });
  }
}
