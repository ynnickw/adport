import { GoogleAdsRestClient } from '@adport/provider-google';
import { NextResponse } from 'next/server';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { exchangeGoogleCode } from '@/lib/cloud/google-oauth';
import { consumeOAuthTransaction, recordAudit, setConnectionVerification, upsertGoogleConnection } from '@/lib/cloud/repository';
import { googleEnv } from '@/lib/env';

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');
    if (oauthError) throw new Error(`Google authorization was not completed: ${oauthError}`);
    if (!code || !state) throw new Error('Google OAuth callback is missing code or state.');
    const principal = await sessionPrincipal();
    const transaction = await consumeOAuthTransaction(state, principal.userId!);
    principal.organizationId = transaction.organizationId;
    const tokens = await exchangeGoogleCode(code, transaction.verifier);
    const config = googleEnv();
    await upsertGoogleConnection({
      organizationId: transaction.organizationId,
      userId: principal.userId!,
      refreshToken: tokens.refreshToken,
      accessibleCustomerIds: [],
      loginCustomerId: config.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    });
    const client = new GoogleAdsRestClient({
      developerToken: config.GOOGLE_ADS_DEVELOPER_TOKEN,
      clientId: config.GOOGLE_ADS_CLIENT_ID,
      clientSecret: config.GOOGLE_ADS_CLIENT_SECRET,
      refreshToken: tokens.refreshToken,
      loginCustomerId: config.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    });
    let customers: string[];
    try {
      customers = await client.listAccessibleCustomers();
    } catch (error) {
      await setConnectionVerification(transaction.organizationId, 'google', {
        ok: false,
        error: 'Google Ads credential verification failed. Retry or disconnect to revoke access.',
      });
      throw error;
    }
    await upsertGoogleConnection({
      organizationId: transaction.organizationId,
      userId: principal.userId!,
      refreshToken: tokens.refreshToken,
      accessibleCustomerIds: customers,
      loginCustomerId: config.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    });
    await recordAudit(principal, {
      event: 'connected', provider: 'google', tool: 'oauth_connect', accountId: '*',
      summary: `Connected ${customers.length} accessible Google Ads account(s)`, details: { accountCount: customers.length },
    });
    return NextResponse.redirect(new URL(`${transaction.returnPath}?connected=google`, request.url));
  } catch (error) {
    console.error('Google OAuth callback failed:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.redirect(new URL('/dashboard?error=Google+connection+failed.+Please+retry.', request.url));
  }
}
