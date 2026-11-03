# Provider connection guide

Adport stores credentials locally in `${ADPORT_HOME:-~/.config/adport}/credentials.json` with file mode `0600`. Do not paste credentials into issues, commit them to Git, or place them in shell history. Run `adport doctor` after connecting a provider.

The CLI connection commands below are bring-your-own (BYO): you own the provider-side application and Adport communicates directly from your machine to that provider. The hosted Adport Cloud broker is not used by these commands. The cloud application is documented separately in [cloud-local-development.md](cloud/local-development.md) and [hosted provider onboarding](./providers/cloud-onboarding.md). Hosted availability depends on app configuration, provider approval and rollout gates.

New in v0.6.0: [Snapchat](./providers/snapchat.md), [Spotify](./providers/spotify.md), [Pinterest](./providers/pinterest.md), [LinkedIn](./providers/linkedin.md) and [X Ads](./providers/x.md). Each guide documents its BYO connection command, typed operations, reporting semantics and testing boundaries. These providers expose the documented typed surface, not unrestricted generic API writes.

For a source checkout, replace `adport` below with `node packages/cli/dist/index.js` after `pnpm build`.

## API versions and native coverage

| Provider | API line | Native read surface | Native mutation surface |
| --- | --- | --- | --- |
| Google | Google Ads API v25 | `google_gaql` covers every GAQL resource and field available to the credential | `google_api_create`, `google_api_update`, and `google_api_remove` route to v25 mutate services |
| Meta | Marketing API v25.0 | `meta_api_read` covers ad-account edges; `meta_insights` is the reporting convenience tool | `meta_api_create`, `meta_api_update`, and `meta_api_delete` cover account-owned Marketing API objects |
| TikTok | Business API v1.3 | `tiktok_api_read` covers documented GET endpoints | `tiktok_api_create`, `tiktok_api_update`, and `tiktok_api_delete` cover endpoints with the matching action suffix |
| Apple | Ads Platform API v1 | Native reports, recommendations/suggestions, insights, app/geo/eligibility discovery, configuration and creative cards; `apple_api_read` for other documented queries | Typed targeting, Search Match, creative/name/status edits, keyword/bid/budget tools and resource removal; generic guarded entity mutations |
| Microsoft | Advertising API v13 | `microsoft_api_read` covers query, search, get, and reporting operations | `microsoft_api_create`, `microsoft_api_update`, and `microsoft_api_delete` cover Campaign Management collections |
| Reddit | Ads API v3 | `reddit_api_read` covers account-scoped GET and read-only POST endpoints; `reddit_report` exposes native reports | `reddit_api_create`, `reddit_api_update`, and `reddit_api_delete` cover account-owned v3 resources |

The native tools accept provider-shaped payloads, so use the provider's current API reference when composing them. They are still normal Adport tools: every mutation goes through the same preview, pending-operation binding, policy checks, and audit log as the typed convenience tools. Created campaigns are forced paused. Generic budget updates are deliberately rejected; use the provider's typed budget tool so Adport can fetch the current value and enforce the exact before/after delta. Generic deletes use a client-side preview when the provider has no applicable validation endpoint.

## Google Ads

You need a Google Cloud project with Google Ads API access and an OAuth desktop client in that project. Developer tokens were retired in September 2026 and are no longer required or sent by Adport.

1. Open the Google Ads API Overview in Google Cloud Console for your project.
2. Verify its API access level: production accounts require Explorer, Basic, or Standard access, not Test access.
3. In Google Cloud, enable the Google Ads API and configure the OAuth consent screen. For a private project, use a truthful name such as `Adport Local – Acme`; the developer/support identity shown by Google belongs to you.
4. Create an OAuth client of type **Desktop app** and download its JSON file.
5. Run `adport connect google`, provide the client JSON, then sign in with a Google user that can access the intended ad accounts.
6. If applicable, provide the manager customer ID used as `login-customer-id`.

Existing credential files and `google-ads.yaml` imports continue to work; any legacy developer token is ignored. No reconnection is needed for this migration. See [Google's migration guidance](https://developers.google.com/google-ads/api/docs/api-policy/developer-token). Cloud operators should also check the project's IAM contacts for API compliance notices.

Google refresh tokens are stored locally. If consent is still in testing mode, Google may expire the authorization after approximately seven days; publish the consent configuration or re-authorize as appropriate for your application.

### Keyword planning

`google_keyword_ideas` discovers keywords from a keyword seed, URL, both, or a site. `google_keyword_historical_metrics` returns historical search volumes, competition and bid estimates for supplied keywords. Both are read-only tools in the shared MCP/CLI registry; neither creates a keyword plan or campaign. Both accept the selected `account_id`, optional language and up to ten location IDs, and explicitly default to Google Search without partners.

Idea results contain one native page. Continue with `next_page_token` as `page_token` and the same seed and targeting. A short or empty page can still have a continuation token. Native metrics retain their original names and integer strings, including monetary values in micros; unavailable values remain absent. Google can merge close variants, so historical results need not have one row per supplied keyword. These are historical estimates, not forecasts or delivery guarantees.

The REST paths, seed variants and limits follow Google's [v25 keyword planning protocol](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/services/keyword_plan_idea_service.proto). Provider authorization, API quotas and account eligibility still apply.

### Shared assets and extensions

`google_assets` provides a visual account-owned library with native image previews, extension copy, policy information and name-edit actions. `google_upload_image_asset` accepts checksum-bound PNG/JPEG/GIF bytes; hosted calls use the private project media library. `google_create_youtube_asset` references an existing video without uploading or publishing one. `google_create_extension_asset` creates an unattached sitelink, callout or structured snippet. Creation previews use Google's native `validate_only`; no association or ad is created by these asset tools.

`google_rename_asset` changes only the shared name. `google_update_extension_asset` edits supported extension content of the same type. Every ad sharing that extension, including active ads, can change. Omitted sitelink descriptions are preserved; supply both as empty strings to clear them. Text, image and YouTube content are not editable through this extension tool.

`google_asset_links` reads associations for a customer, campaign or ad group. `google_link_asset` attaches a compatible owned asset, defaulting to PAUSED with policy coercions reported. `google_set_asset_link_status` pauses or enables an existing association; `google_unlink_asset` removes that exact association. Native validation determines placement eligibility. Parent campaign/ad statuses are independent, and every serving use of an association can be affected. These tools cover sitelinks, callouts, structured snippets, ad images and business branding; they do not implement a complete Performance Max asset-group hierarchy.

Google's [Asset protocol](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/resources/asset.proto) and [AssetOperation](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/services/asset_service.proto) provide no asset-removal operation. Assets remain in the library after unlinking; Adport does not advertise an asset-delete tool. Association status and removal follow the native [CampaignAsset](https://github.com/googleapis/googleapis/blob/master/google/ads/googleads/v25/resources/campaign_asset.proto) contract, with corresponding customer/ad-group services.

### Labels

`google_labels` lists enabled account-owned labels with native ID continuation. `google_label_context` reads one label and returns `snapshot_hash`; supply it as `expected_label_hash` when updating or removing that label, or changing an assignment. Metadata changes after the read reject the operation at preview and apply. The snapshot covers label metadata; Google does not provide an atomic compare-and-set or freeze assignment membership.

`google_create_label` creates unattached metadata. `google_update_label` changes only supplied name, hex background color or description; omission preserves a field and an empty description clears it. `google_remove_label` removes the shared label and its assignments. Label names are 1–80 characters and descriptions at most 200. Labels have no pause state; Adport does not invent one. Every mutation uses the normal two-step policy gate and native `validate_only` preview.

`google_label_associations`, `google_link_label` and `google_unlink_label` cover campaigns, ad groups, ads and ad-group criteria. The target includes the full campaign/ad-group hierarchy, checked in the selected account before use. Association lists report truncation. Unlinking preserves the label and labeled entity; removing the label affects all assignments. Classification can affect label-based reports and automation, while these tools preserve serving statuses, entity content and budgets.

The wire formats follow the [v25 label service](https://github.com/googleapis/googleapis/blob/57aa4dbce5d23b2115b2732b10dcb7ddc8e8698d/google/ads/googleads/v25/services/label_service.proto) and corresponding campaign/ad-group/ad/criterion label services. Manager-to-customer labels use a different native contract and are not exposed by these named tools.

Google can show an “unverified app” warning when your private OAuth project requests the Google Ads scope without completing verification. For the CLI, that warning concerns your BYO project and credentials are not sent to Adport Cloud. Add yourself as a test user during development. The managed cloud application's own OAuth project must complete Google's production verification before public use.

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

For local CLI use, Apple Ads uses the OAuth 2.0 client-credentials flow with API-user key material. Adport Cloud instead uses Adport's Apple-approved service-provider authorization-code flow, so cloud tenants authorize in the browser and never provide private keys.

1. In Apple Ads Account Settings, create or invite an API user with the required role.
2. Generate an EC `prime256v1` private key locally and derive its public key:

   ```sh
   openssl ecparam -genkey -name prime256v1 -noout -out private-key.pem
   openssl ec -in private-key.pem -pubout -out public-key.pem
   ```

3. Upload only `public-key.pem` in Apple Ads and record the displayed client ID, team ID, and key ID.
4. Run `adport connect apple` and provide the identifiers plus the local path to `private-key.pem`.

Never upload or commit the private key. Adport mints short-lived ES256 client assertions locally and exchanges them for Apple OAuth bearer tokens with the `searchadsorg` scope. Campaign Management API v5 sunsets on 2027-01-26; the provider isolates the version boundary for migration to Apple's successor API.

## Microsoft Advertising

Microsoft requires an Entra application and a Microsoft Advertising developer token.

1. Register an Entra application that supports the Microsoft account types you need.
2. Configure **Public client/native (mobile & desktop)** with redirect URI `http://localhost`. Do not create a client secret for the CLI.
3. In Microsoft Advertising Developer settings, obtain the production developer token. The sandbox also has a universal token.
4. Ensure the Microsoft identity used for OAuth has accepted access to the intended Microsoft Advertising manager or advertiser account.
5. Run `adport connect microsoft`, select the correct environment, and complete the PKCE sign-in.

Adport persists rotated Microsoft refresh tokens after use. Public-client refresh tokens can expire after extended inactivity, in which case run the connect command again.

Microsoft may show an unverified-publisher notice or require administrator consent based on your Entra application and tenant policy. For the CLI, that identity belongs to your application; the Adport Cloud broker uses an Adport-owned Entra application with its own publisher verification.

`microsoft_images` and `microsoft_get_library_image` expose the selected account's image library, native previews and creation-time alt text. `microsoft_upload_image` accepts a SHA-256-bound static PNG, JPEG or GIF, up to 76,800 bytes; hosted calls require a project `media_id`. It creates an unattached asset and verifies the returned ID and requested alt text through the account library. Microsoft converts PNG to JPEG and validates dimensions and animation. These operations use the same guarded preview/apply flow from the CLI, MCP and creative gallery.

`microsoft_image_extension_associations` reports image-extension uses only. An empty result does not establish that a responsive ad is not using the image. `microsoft_delete_image` verifies account ownership, blocks known extension references, relies on Microsoft's atomic rejection of any assigned media, and confirms disappearance. Existing-image alt-text updates are not exposed: a live update was accepted but did not change the readback. Replacement uploads and explicit reference changes are required instead. These contracts were checked against the [official media reference](https://learn.microsoft.com/en-us/advertising/campaign-management-service/image?view=bingads-13) and SDK; library reads and creation-time alt text were live-verified on 2026-11-03.

`microsoft_ad_extensions` provides a paginated gallery for callouts, sitelinks, structured snippets and image extensions. Create, update, delete, link and unlink tools use the same guarded registry as the CLI. Updates require the latest `expected_version`, preserve omitted mutable fields, scheduling, device preference and tracking, and verify native readback. Shared-content edits can affect every associated entity, including active ads. Microsoft's version field is read-only, so the preflight version check is not an atomic server-side lock. Image extension alternative text is distinct from the source media's alt text. Unknown non-null content fields block a full replacement rather than being silently dropped.

Extensions are natively Active but cannot serve while unattached. New associations have no paused state: the default `paused_creation` policy requires a paused campaign or ad group and blocks account-wide associations. Association reads preserve direct native editorial status; they do not combine inherited associations. Native editorial rejection remains a failure even when HTTP succeeds. Sitelink creation/editing and association/unlink readback were live-verified on 2026-11-03.

Image-extension placement crops have stricter pixel requirements than library uploads. A live 640×640 library image was rejected with native code 6235; a separate 1200×628 fixture passed. Image-extension and structured-snippet creation, callout creation/deletion, and SHA-bound image upload/readback were also live-verified. No live QA ad was created or activated.

`microsoft_campaign_targets` reads one concrete subtype: age, gender, device, day/time, location, location intent or radius. Mutation tools use Microsoft's `Targets` selector, validate account/campaign ownership, bind edits to expected current bid or intent values, and confirm readback. New targets have native Active status, so default policy requires a paused campaign. Bid adjustments are integer percentages, generally -90 through 900; devices also support -100 for exclusion. Native REST radius values are decimal strings. Deprecated geographical IDs remain the provider's validation responsibility; `microsoft_geo_locations_file` returns the current reference-file URL and expiry.

Device creation and removal require all three device types together. Location intent cannot be deleted; use `microsoft_set_campaign_location_intent` with `PeopleInOrSearchingForOrViewingPages` to restore the API default. These constraints were confirmed against real endpoints, including native errors 2957 and 2965. Day/time creation, bid editing and removal, plus device/age/gender/radius creation and cleanup and location-intent editing, were live-verified on a paused QA campaign. Location inclusion/exclusion has contract tests but has not yet been live-verified. Audience targeting, ad-group targeting, performance planners and additional extension formats remain separate coverage gaps.

`microsoft_negative_keywords` reads direct campaign or ad-group exclusions with keyset pagination. Add/remove tools verify the full account/parent hierarchy, support native Exact/Phrase matches, preserve inherited and shared-list exclusions, and confirm returned IDs and content. Negative keywords have no individual pause state; adding them restricts delivery without changing parent status. Text and match type are immutable: add and verify a replacement before removing its predecessor. Each call accepts up to 1,000 entries within Microsoft's 20,000-entry direct-entity limit. Campaign and ad-group creation, pagination and removal were live-verified and their QA fixtures cleaned up on 2026-11-03. See the [official entity-query contract](https://github.com/MicrosoftDocs/Advertising/blob/fdee2fcf05a65d4837f2d171396ee345577681d2/advertising/bingads-13/campaign-management-service/getnegativekeywordsbyentityids.md). Shared negative-keyword lists remain a separate workflow.

## Reddit Ads

Reddit uses OAuth 2.0 with a confidential developer application and requires an honest, uniquely identifying `User-Agent` on every request.

1. Create a **web app** at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) under the Reddit user that can access the intended Ads businesses.
2. Register an exact local redirect URI such as `http://localhost:53682`.
3. Run `adport connect reddit` and provide the app/client ID, app secret, the exact redirect URI, and a truthful User-Agent such as `desktop:dev.adport.local:v0.4.0 (by /u/yourname)`.
4. Approve the requested `adsread`, `adsedit`, and `adsdatadeletion` scopes. Adport requests `duration=permanent` and stores the refresh token locally.
5. Verify discovery with `adport accounts --provider reddit` and reporting with `adport report --provider reddit`.

Reddit Ads API v3 campaign budget, bid, spend, CPC, and CPM fields use integer micros. Conversion total-value report fields use cents. Adport preserves native micros for policy checks and converts reports to whole account-currency units without fabricating missing conversions. Report pagination repeats the original POST body and remains bound to the selected account. Reddit requires `conversion_pixel_id` for CBO campaigns; campaign budget type is immutable. The current objective enums are enforced, with `CLICKS` as the default. Transport, pagination and campaign receipts were checked against the [official v3 OpenAPI](https://ads-api.reddit.com/api/v3/openapi.json) on 2026-11-03. These contract checks are separate from live account verification.

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
