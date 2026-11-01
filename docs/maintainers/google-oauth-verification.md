# Google OAuth verification runbook

Google's August 2026 message is a consolidated audit checklist, not an approval or a specific rejection. Do not reply “completed” until the production/staging app, Cloud Console, privacy page, reviewer access, and video all match.

## Scope and justification

Adport Cloud requests exactly one Google scope:

```text
https://www.googleapis.com/auth/adwords
```

Suggested justification for Cloud Console:

> Adport is a paid-media control plane. A user connects Google Ads to list the customer accounts they can access; view account and campaign configuration; retrieve and normalize Google Ads performance reports; preview proposed campaign, budget, bidding, ad-group, ad, keyword, targeting, and status changes; and apply an exact user-approved change through a mandatory two-step safety gate. The Google Ads API exposes one OAuth scope, `https://www.googleapis.com/auth/adwords`, for these read and management operations. No narrower Google Ads OAuth scope can provide the production features shown in Adport. Adport does not request Gmail, Drive, Calendar, Contacts, Photos, Workspace, or general Google profile scopes.

The authorization URL is generated server-side with that exact scope, offline access, explicit consent, PKCE S256, and a one-time hashed state. Keep the Cloud Console data-access list and the demo consent screen identical to this value.

## Implementation evidence

- Google OAuth (scope, PKCE, exchange, revoke): `apps/cloud/lib/cloud/google-oauth.ts`
- Hosted OAuth broker (Google adapter alongside Meta/TikTok/Microsoft/Reddit): `apps/cloud/lib/cloud/provider-oauth.ts`
- One-time OAuth transaction and encrypted token vault: `apps/cloud/lib/cloud/repository.ts`
- Start and callback with connection verification: `apps/cloud/app/api/oauth/[provider]/start/route.ts`, `apps/cloud/app/api/oauth/[provider]/callback/route.ts` (the Google URL is `/api/oauth/google/callback`)
- Revocation-before-deletion: `apps/cloud/app/api/connections/[provider]/route.ts`
- In-product data-access explanation and Connect button: `apps/cloud/app/dashboard/connections/page.tsx`
- Shared preview/apply policy path: `packages/core/src/policy/engine.ts`
- Tenant REST/MCP runtime: `apps/cloud/lib/cloud/runtime.ts`
- Tenant schema, RLS, restricted backend role, retention: `supabase/migrations/20260817171039_cloud_initial_schema.sql`
- Public disclosures: `website/privacy.html`

Automated checks cover exact scope/PKCE, encryption with tenant-bound authenticated data, RLS isolation, durable preview/apply/audit, API-key authorization, MCP handshake and scope filtering, retention, and production build rendering. These tests do not replace Google's manual review or a real Google Ads source-account demo.

## Cloud Console checklist

- Use project `adport-ads-2026-0812` (project number `376485968015`) consistently in the submission and demo.
- Verify the production domain and ensure the homepage identifies Adport, explains the product, and links the same privacy URL configured on the consent screen.
- Set the app publishing status to **In production** when submitting. Use a separate staging/test project for unverified changes.
- Register the exact production web redirect: `https://<cloud-domain>/api/oauth/google/callback`. Remove obsolete redirects before recording.
- Configure only `https://www.googleapis.com/auth/adwords` in Data Access. Confirm the code, Console, justification, and expanded consent screen match character-for-character.
- Confirm app name, logo, support email, developer contact, homepage, privacy URL, and authorized domains all use the production Adport identity.
- Inspect the scope classification shown by Cloud Console. If Google classifies any requested scope as **Restricted**, follow the CASA assessment instructions Google provides; do not assume CASA is or is not required from the generic email alone.
- Do not expose the unverified production client to public traffic. Keep new/unverified consent changes in staging until approved.

## Reviewer environment

Provide Google privately by reply or in the verification submission:

- production/staging login URL;
- one dedicated reviewer email/password with no phone, payment, CAPTCHA, or MFA blocker;
- exact navigation: sign in at the app root → Connections (sidebar) → Google Ads → Connect Google Ads;
- a Google test identity that can consent and access a non-sensitive test Google Ads account, if Google asks you to supply it;
- any manager/customer relationship needed to see the test account; and
- a short note that the first write call only previews and the second exact call applies.

Never put reviewer credentials, OAuth secrets, developer tokens, customer IDs, or private account data in this repository or the public demo description.

## Demo video shot list

Upload the video as public or unlisted YouTube content and keep the consent-screen language set to English.

1. Show the production Adport homepage, product description, privacy link, domain, and app branding.
2. Sign in with the reviewer flow (the app root is the sign-in screen) and navigate visibly to **Connections → Google Ads** in the sidebar.
3. Show the in-product explanation of what Google Ads data is accessed and why.
4. Click **Connect Google Ads**. Show the complete Google consent flow, expand **Show all services** if present, and keep the full `adwords` permission readable.
5. Return to Adport and show accessible accounts plus a live campaign report. Explain that raw reports are fetched on request and not durably stored by default.
6. Demonstrate a safe write on the test account: submit the change once, show the preview/pending ID and coercions/budget delta, then submit the identical approved operation.
7. Open Google Ads and show that exact change reflected in the source account. If demonstrating remove/delete, show the source resource impact too.
8. Return to Adport and show the audit event.
9. Show Google disconnect/revocation on the Connections card and the organization deletion control under Team. Explain default 90-day retention and configurable scheduled deletion.

Do not edit the video after submitting unless you also update the review response with the new URL.

## Privacy checklist from Google's notice

- **Data access:** raw tokens, account identifiers/configuration, entities, targeting, change history, and performance metrics; derived reports, previews, budget deltas, findings, pending records, and audit events.
- **Data use:** user-visible connection, reporting, inspection, findings, preview, and exact user-approved create/update/status/remove features.
- **Data transfer:** Google endpoints, contracted hosting/database/auth providers, and a user-selected MCP/AI client only on the user's request; never tokens.
- **Protection:** TLS, encrypted tenant vault, PKCE/one-time state, RLS, restricted backend role, RBAC, keyed API-key digests, rate limits, and audit logging.
- **Retention/deletion:** credentials until disconnect/deletion; OAuth transaction cleanup; one-hour rate buckets; 90-day configurable tenant-event retention; report results not stored by default; cascading organization deletion.
- **Limited Use:** no sale, targeted advertising, data brokerage, lending, unrelated profiling, surveillance, or general/shared AI model training.

## Reply draft

> Hello Third Party Data Safety Team,
>
> We completed the requested audit for Google Cloud project adport-ads-2026-0812 (376485968015). Adport requests only `https://www.googleapis.com/auth/adwords`, which is the single Google Ads OAuth scope required for the production reporting and user-approved account-management features demonstrated in our video. We do not request Workspace, Gmail, Drive, Photos, or unrelated Google scopes.
>
> We updated the production privacy policy to state the exact raw and derived Google Ads data accessed, how it is used, the limited service-provider and user-directed transfers, security controls, retention/deletion behavior, Limited Use compliance, and the prohibition on shared/general AI model training. The same privacy URL is linked from the homepage, in the product, and in the OAuth consent configuration.
>
> Demo video: [UNLISTED YOUTUBE URL]
>
> Reviewer login URL: [URL]
>
> Navigation: sign in → Connections → Google Ads → Connect Google Ads. Reviewer credentials and test-account details are provided below/private in this submission: [CREDENTIALS — DO NOT PLACE IN A PUBLIC LINK]
>
> The video shows the complete expanded English consent screen, exact scope, account/report functionality, the two-step preview and apply flow, the resulting change in the Google Ads source account, audit history, and disconnect/revocation.
>
> Please continue the verification review and let us know if any additional evidence is required.

Replace every bracketed field and re-run the checklist before sending.
