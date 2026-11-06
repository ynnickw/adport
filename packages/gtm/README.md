# Google Tag Manager provider

Google Tag Manager API v2 configuration access for Adport. OAuth credentials are
stored separately from Google Ads. Enable `tagmanager.googleapis.com` on your
Google Cloud project, create a Desktop OAuth client, set `GTM_CLIENT_SECRET` in
your terminal, then run `adport connect gtm`. Alternatively set `GTM_CLIENT_ID`,
`GTM_CLIENT_SECRET` and `GTM_REFRESH_TOKEN` for local CLI/stdio use.

Read accounts, containers, installation snippets, workspaces, tags, triggers, variables, saved versions,
the live version, and pending workspace changes. Lists expose native
`nextPageToken`; pass it as `page_token` to continue. GTM supplies configuration,
not website traffic, runtime variable values or conversion reports.

Create workspaces and create/update tags, triggers and variables using native
camelCase API configuration fields. Every mutation uses the shared two-step
policy engine. Previews only read upstream configuration; `serverValidated` is
false because GTM has no validate-only mutation option. Draft changes do not
publish. Updates require the resource's latest `expected_fingerprint`.

To release configuration:

1. Inspect the complete draft and call `gtm_workspace_status`.
2. Preview/apply `gtm_create_version` with the returned `expected_workspace_hash`.
   This includes **all** workspace changes and Google replaces the workspace.
3. Inspect the resulting version and test it using GTM Preview/Tag Assistant.
4. Preview/apply `gtm_publish_version` with the saved version fingerprint and
   `expected_live_version_id` (`0` for a never-published container).

Version publishing is a separate explicit approval. Changes to reviewed resources,
workspace changes or the live version require a fresh read/preview. The API cannot
install GTM on a website or supply missing data-layer events. Google Ads conversion
actions are created separately with the Google Ads tools. This initial connector
does not delete containers/resources or manage account users.

Cloud uses the existing Google application with a separate `/api/oauth/gtm/callback`
and these scopes: `tagmanager.edit.containers`, `tagmanager.edit.containerversions`,
`tagmanager.publish`. These cover configuration reads too; no redundant readonly,
container deletion or user-management scopes are requested. `GTM_OAUTH_ENABLED`
defaults false until the application's GTM configuration is ready for external users.
`GTM_TEST_ORGANIZATION_IDS` permits explicitly named internal review projects only.
Users select which GTM accounts their project can access in Analytics & tracking.
GTM accounts do not use advertising account slots. Containers within an enabled account share
that account's access boundary.

Disconnecting GTM deletes Adport's stored grant. Google app-wide revocation is
manual because it can also revoke Google Ads access granted to the same app.
