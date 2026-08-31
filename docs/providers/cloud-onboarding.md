# Hosted provider onboarding

The cloud runtime now includes Snapchat, Spotify, Pinterest, LinkedIn and X
alongside the existing providers. Runtime support is not proof of API approval
or a successful live account connection.

## OAuth 2.0 applications

Register the exact callback for each server-owned app:

| Provider | Callback | Server environment prefix |
| --- | --- | --- |
| Snapchat | `https://app.adport.dev/api/oauth/snapchat/callback` | `SNAPCHAT` |
| Spotify | `https://app.adport.dev/api/oauth/spotify/callback` | `SPOTIFY` |
| Pinterest | `https://app.adport.dev/api/oauth/pinterest/callback` | `PINTEREST` |
| LinkedIn | `https://app.adport.dev/api/oauth/linkedin/callback` | `LINKEDIN` |

Use the configured `ADPORT_CLOUD_BASE_URL` instead for another deployment.
`/api/auth/<provider>/callback` is **not** the hosted callback route.

For each prefix, configure `<PREFIX>_CLIENT_ID` and `<PREFIX>_CLIENT_SECRET`
in server-only environment secrets. `<PREFIX>_OAUTH_ENABLED` defaults to
`false`; set it to `true` only for an authorized rollout after verifying the
platform's approval/access level. Merely creating an app is not approval for
external advertisers. No platform secrets belong in Git or `NEXT_PUBLIC_*`.

Apply the reviewed provider-expansion database migration before enabling these
connections. It extends the provider checks on connections, encrypted grants,
OAuth transactions and organization ad accounts; it does not change tenant
policies or database grants.

For a restricted test rollout, set `ADPORT_PROVIDER_TEST_ORGANIZATION_IDS` to a
comma-separated list of permitted organization UUIDs. This gate applies to all
five new providers, including their start/callback routes and runtime. An empty
value allows none; omitting the variable removes the organization restriction.

## Tenant grant lifecycle

- The existing authenticated callback consumes one-time state and rechecks the
  initiating user's organization membership and administrator role.
- Discovery synchronizes accessible accounts into the organization's account
  inventory. The active-account plan limit is enforced independently of tokens.
- Runtime clients receive server-owned app identity plus the tenant grant.
  Native tools and normalized reads/writes enforce enabled account inventory.
- Refresh-token rotation locks the current encrypted row, checks organization,
  connection and previous grant, and merges token fields only. It preserves
  other stored fields and rejects a superseded grant. Account enablement lives
  separately from credentials and cannot be overwritten by token refresh.
- LinkedIn stores expiry timestamps in milliseconds. Programmatic refresh
  depends on the grant; access-token-only grants require reauthorization.
- These four adapters currently require **manual provider-side revocation**.
  Disconnect deletes the cloud credential and points the user to provider
  settings; it does not claim that the platform token has been revoked.

## X

X uses a separate OAuth 1.0a handshake within the shared hosted flow. Register
`https://app.adport.dev/api/oauth/x/callback` and configure server-only
`X_CONSUMER_KEY` and `X_CONSUMER_SECRET`. `X_OAUTH_ENABLED` defaults to `false`;
enable it only for an authorized rollout with Ads API-approved app access.

The start route requests a temporary token with the exact callback, checks
`oauth_callback_confirmed=true`, and stores its hash plus encrypted secret in
the initiating user's organization-bound transaction. The browser receives only
the temporary token at X's `oauth/authorize` endpoint. The callback uses
`oauth_token` and `oauth_verifier`; it consumes the single-use transaction and
rechecks administrator access before exchanging and storing the user grant.
Account discovery and plan-limited inventory synchronization then run through
the shared callback. It does not use OAuth 2.0 scopes, bearer tokens, or an invented state query
on the registered callback. User tokens do not expire automatically but can be
revoked. Disconnect uses X's documented OAuth 1.0a invalidation endpoint and
requires a response confirming the same token.

The wire and route tests pass; this is not an X approval or live consent claim.
Do not ask users to paste platform credentials into chat. See X's [official
three-legged flow](https://docs.x.com/fundamentals/authentication/oauth-1-0a/obtaining-user-access-tokens)
and [authentication reference](https://docs.x.com/fundamentals/authentication/api-reference).

## Verification boundary

OAuth adapter tests reuse the packages' official-schema token exchanges and
check hosted redirects, state, scopes, app gating and secret-safe failures.
Runtime tests check all five modules and disabled-account rejection.
Credential unit tests exercise superseded-grant rejection and token-only merges.
These are not live provider approval, production migration, rendered
dashboard or end-to-end external consent evidence.
