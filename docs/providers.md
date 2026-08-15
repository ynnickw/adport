# Provider connection guide

Adport stores credentials locally in `${ADPORT_HOME:-~/.config/adport}/credentials.json` with file mode `0600`. Do not paste credentials into issues, commit them to Git, or place them in shell history. Run `adport doctor` after connecting a provider.

Every connection below is bring-your-own (BYO): you own the provider-side application and Adport communicates directly from your machine to that provider. The hosted Adport Cloud OAuth broker is not used. A provider may therefore show your application name, contact email, verification status, or organization policy during authorization. This is distinct from the future verified, one-click Adport Cloud flow.

For a source checkout, replace `adport` below with `node packages/cli/dist/index.js` after `pnpm build`.

## API versions and native coverage

| Provider | API line | Native read surface | Native mutation surface |
| --- | --- | --- | --- |
| Google | Google Ads API v25 | `google_gaql` covers every GAQL resource and field available to the credential | `google_api_create`, `google_api_update`, and `google_api_remove` route to v25 mutate services |
| Meta | Marketing API v25.0 | `meta_api_read` covers ad-account edges; `meta_insights` is the reporting convenience tool | `meta_api_create`, `meta_api_update`, and `meta_api_delete` cover account-owned Marketing API objects |
| TikTok | Business API v1.3 | `tiktok_api_read` covers documented GET endpoints | `tiktok_api_create`, `tiktok_api_update`, and `tiktok_api_delete` cover endpoints with the matching action suffix |
| Apple | Apple Ads Platform API v1 | `apple_api_read` covers every published GET, `/query`, report, insight, suggestion, eligibility, and recommendation-query operation | typed campaigns/budgets/recommendations/assets plus `apple_api_create`, `apple_api_update`, and `apple_api_delete` cover every published v1 mutation class without bypassing policy |
| Microsoft | Advertising API v13 | `microsoft_api_read` covers query, search, get, and reporting operations | `microsoft_api_create`, `microsoft_api_update`, and `microsoft_api_delete` cover Campaign Management collections |
| Reddit | Ads API v3 | `reddit_api_read` covers account-scoped GET and read-only POST endpoints; `reddit_report` exposes native reports | `reddit_api_create`, `reddit_api_update`, and `reddit_api_delete` cover account-owned v3 resources |

The native tools accept provider-shaped payloads, so use the provider's current API reference when composing them. They are still normal Adport tools: every mutation goes through the same preview, pending-operation binding, policy checks, and audit log as the typed convenience tools. Created campaigns are forced paused. Generic budget updates are deliberately rejected; use the provider's typed budget tool so Adport can fetch the current value and enforce the exact before/after delta. Generic deletes use a client-side preview when the provider has no applicable validation endpoint.

## Google Ads

You need a Google Ads developer token and a Google Cloud OAuth desktop client.

1. Create or use a Google Ads manager account and open its API Center.
2. Obtain a developer token.
3. In Google Cloud, enable the Google Ads API and configure the OAuth consent screen. For a private project, use a truthful name such as `Adport Local – Acme`; the developer/support identity shown by Google belongs to you.
4. Create an OAuth client of type **Desktop app** and download its JSON file.
5. Run `adport connect google`, provide the developer token and client JSON, then sign in with a Google user that can access the intended ad accounts.
6. If applicable, provide the manager customer ID used as `login-customer-id`.

Google refresh tokens are stored locally. If consent is still in testing mode, Google may expire the authorization after approximately seven days; publish the consent configuration or re-authorize as appropriate for your application.

Google can show an “unverified app” warning when your private OAuth project requests the Google Ads scope without completing verification. That warning concerns your BYO project; it does not mean credentials are sent to Adport Cloud. Add yourself as a test user during development. Public use of your OAuth app may require Google verification.

## Meta Ads

For accounts you control, use a Meta Business app with the Marketing API product and a system-user token.

1. Create a Business-type app in Meta for Developers and add Marketing API.
2. In Business Settings, create a system user and assign the required ad accounts.
3. Generate a token with `ads_read` and `ads_management`.
4. Run `adport connect meta` and provide the token. The app ID and app secret are optional and enable token diagnostics.

System-user tokens are preferred. Extended user tokens normally expire and require re-authorization. App Review and business verification may be required before an app can authorize assets belonging to other businesses.

## TikTok Ads

TikTok supports a sandbox for development; production access requires an approved Business API application.

1. Register in the TikTok Business API portal and create an app.
2. For development, create a sandbox advertiser and generate its access token.
3. For production, complete TikTok's application review and advertiser authorization flow.
4. Run `adport connect tiktok`, select sandbox or production, and provide the app ID, app secret, and access token.

Keep the environment consistent: sandbox credentials cannot be used against production endpoints.

## Apple Ads

Apple Ads uses an API-user key flow rather than an interactive end-user OAuth flow.

1. In Apple Ads Account Settings, create or invite an API user with the required role.
2. Generate an EC `prime256v1` private key locally and derive its public key:

   ```sh
   openssl ecparam -genkey -name prime256v1 -noout -out private-key.pem
   openssl ec -in private-key.pem -pubout -out public-key.pem
   ```

3. Upload only `public-key.pem` in Apple Ads and record the displayed client ID, team ID, and key ID.
4. Run `adport connect apple` and provide the identifiers plus the local path to `private-key.pem`.

Never upload or commit the private key. Adport mints short-lived ES256 client assertions locally and calls Apple Ads Platform API v1. Use the ad account ID returned by `/acls` as `account_id`; v1 sends it as `X-AP-Context: adAccountId=…`.

The v1 provider includes App Store and Apple Maps campaign resources, reports, impression-share and search-term-popularity insights, recommendations and suggestions, shared budgets, bulk keyword operations, change history, and creative assets. Asset uploads require a local file path plus its SHA-256 so the preview/apply gate is bound to the exact bytes. Recommendation applies are re-queried before preview so daily-budget and target-CPA deltas are policy checked; raw monetary updates remain intentionally rejected.

## Microsoft Advertising

Microsoft requires an Entra application and a Microsoft Advertising developer token.

1. Register an Entra application that supports the Microsoft account types you need.
2. Configure **Public client/native (mobile & desktop)** with redirect URI `http://localhost`. Do not create a client secret for the CLI.
3. In Microsoft Advertising Developer settings, obtain the production developer token. The sandbox also has a universal token.
4. Ensure the Microsoft identity used for OAuth has accepted access to the intended Microsoft Advertising manager or advertiser account.
5. Run `adport connect microsoft`, select the correct environment, and complete the PKCE sign-in.

Adport persists rotated Microsoft refresh tokens after use. Public-client refresh tokens can expire after extended inactivity, in which case run the connect command again.

Microsoft may show an unverified-publisher notice or require administrator consent based on your Entra application and tenant policy. That identity belongs to your local/BYO setup, not Adport Cloud.

## Reddit Ads

Reddit uses OAuth 2.0 with a confidential developer application and requires an honest, uniquely identifying `User-Agent` on every request.

1. Create a **web app** at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) under the Reddit user that can access the intended Ads businesses.
2. Register an exact local redirect URI such as `http://localhost:53682`.
3. Run `adport connect reddit` and provide the app/client ID, app secret, the exact redirect URI, and a truthful User-Agent such as `desktop:dev.adport.local:v0.5.0 (by /u/yourname)`.
4. Approve the requested `adsread`, `adsedit`, and `adsdatadeletion` scopes. Adport requests `duration=permanent` and stores the refresh token locally.
5. Verify discovery with `adport accounts --provider reddit` and reporting with `adport report --provider reddit`.

Reddit Ads API v3 campaign budget, bid, spend, CPC, and CPM fields use integer micros. Conversion total-value report fields use cents. Adport preserves the native integer micros for policy checks and converts report output to whole account-currency units. Reddit requires `conversion_pixel_id` for CBO campaigns as of July 13, 2026. Reddit has also announced new campaign objective enums for September 30, 2026, so use the current API reference when supplying a native objective.

Read access is open to developers, while some create/edit/delete functionality can depend on Reddit API partner or advertiser approval. A successful OAuth connection therefore does not guarantee mutation access for every app.

## Verification

```sh
adport doctor
adport accounts
adport report --provider google
```

To remove a credential record from this machine:

```sh
adport disconnect google
```

This does not revoke the issued token or key at the provider. Use the provider's security or developer console when access must be invalidated.

An empty report can be valid when an accessible account has no campaigns or no data in the requested range. Account review, billing, or advertiser-verification status is controlled by the provider and is separate from OAuth connectivity.
