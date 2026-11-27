# Matomo

Matomo Cloud and self-hosted sites use the same two website analytics tools as GA4. The adapter reads aggregate reports and goal definitions with read access. [Website analytics contract and examples](website-analytics.md)

## Create a token

In Matomo, open **Administration → Personal → Security → Auth tokens** and create a
token. A user with **view** access to the sites you want to report on is enough;
we recommend a dedicated view-only user so the token cannot change anything even
outside Adport. If Matomo offers it, restrict the token to POST requests: Adport
always sends it in the POST body.

## Connect in Adport Cloud

In **Analytics & tracking**, choose **Add source → Matomo**, enter the instance URL and continue to Matomo. Sign in and approve read access, then choose the sites available to the project. Adport stores the grant in its encrypted project vault and refreshes it on the server.

Each instance needs the Matomo OAuth 2.0 plugin and one confidential client with authorization code, refresh tokens, the exact callback shown under **Set up this instance for the first time** (including its instance identifier) and the `matomo:read` scope. An administrator can enter its client ID and secret during setup or preconfigure the registration through `MATOMO_OAUTH_APPLICATIONS` on the Adport host. A reverse proxy in front of Matomo must forward the Authorization header. For instances without OAuth, select **Auth token** and use a token with view access. [Matomo OAuth setup](https://developer.matomo.org/guides/oauth2/authorization-code)

 Enable the selected sites for assistants. Analytics sites do not consume advertising account slots.

Use a publicly reachable HTTPS domain for Matomo Cloud or a self-hosted installation. For a private-network installation, use the local CLI or stdio MCP on that network. Reconnecting to a different instance clears its predecessor’s site selections because each instance assigns its own site IDs. Disconnect removes the project’s credentials. Revoke the token in Matomo to invalidate it there.

The Standard, Reporting and Full profiles include both shared read tools when Matomo is selected. Use `capabilities_list` with provider `matomo` to check access.

## Connect locally

Provide both values securely in your shell environment:

- `MATOMO_URL`: the instance base URL, for example `https://example.matomo.cloud` or
  `https://analytics.example.com/matomo`. It must use `https` and contain no
  credentials, query or fragment. A trailing `/` or `/index.php` is removed.
- `MATOMO_TOKEN_AUTH`: the auth token.

Run `adport connect matomo`. The command lists the sites the token can view
(`SitesManager.getSitesWithAtLeastViewAccess`) and then stores the normalized URL
and token locally with mode 0600. Without stored credentials, the MCP server and
CLI also load the environment pair. If the stored or environment URL is unusable
(for example not `https`), Matomo is skipped and `adport doctor` shows it as not
connected, while the other providers still load; `adport connect matomo` reports the
error. `adport doctor` checks the connection;
`adport disconnect matomo` removes the local copy only, so delete the token in
Matomo to revoke it.

Every request is `POST <base>/index.php` with `module=API`, `format=JSON` and a bearer header for OAuth or `token_auth` in the form body for token connections. The token never appears in a URL. Redirects are
refused and requests time out after 30 seconds.

## Acquisition data

The free Marketing Campaigns Reporting plugin archives source and medium together, with campaign names in a subtable. Enable the plugin before collecting campaign traffic. A core-only installation can report campaign names and goals. For missing or ambiguous source and medium tags, Adport keeps the counts and returns unresolved dimensions. Adport never combines independent source and medium totals to invent campaign rows.

Landing-page breakdowns use exact entry-URL segments and require Matomo to serve those segmented archives. Adport checks the segment against the recorded entry visits. An incomplete archive results in an actionable error. Landing URLs in the output omit query strings and fragments.

Use the site’s native MCP for arbitrary reports, visitor analysis, realtime monitoring or configuration. [Matomo campaign plugin](https://github.com/matomo-org/plugin-MarketingCampaignsReporting) · [Reporting API](https://developer.matomo.org/guides/reporting-api)
