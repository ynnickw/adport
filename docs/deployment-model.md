# Deployment model

Adport v0.5.0 is an open-source, local-first CLI and stdio MCP server. It is not a hosted OAuth service.

## Current release

- Operators bring their own provider credentials and run `adport connect <provider>` locally.
- Credentials are written to `${ADPORT_HOME:-~/.config/adport}/credentials.json` with file mode `0600`.
- Provider API calls go directly from the operator's machine to the selected advertising platform.
- The MCP server uses stdio. Remote HTTP transport is intentionally not included.
- Mutations use the same policy engine as the CLI: preview first, then apply with an identical pending-operation token.
- Adport sends no telemetry.

The OAuth applications used for local testing are development fixtures. Their tokens and platform configuration are not shared with installations and are not part of the repository.

## Planned managed cloud

A future managed service may provide reviewed provider applications and hosted OAuth callbacks. A customer would authorize an advertising account through an Adport-owned application, and the service would store that customer's credentials in an encrypted, tenant-isolated vault.

That service requires work which is deliberately outside v0.5.0:

- hosted OAuth callback and state validation;
- encrypted, tenant-isolated token storage and rotation;
- tenant authentication and authorization;
- provider app review, publisher verification, and production redirect configuration;
- a remote service transport and operational controls;
- cloud-specific privacy, retention, deletion, and incident-response policies.

The managed service must continue to route every write through the shared Adport policy engine. It must not introduce a mutation path that bypasses preview, confirmation, budget limits, paused creation, or audit logging.

## Provider authorization models

Google, Meta, TikTok, and Microsoft can support a hosted authorization experience once their production applications are approved. Apple Ads currently uses an API user, an uploaded public key, and locally signed ES256 client credentials; cloud onboarding therefore requires a key or delegated API-user workflow unless Apple exposes a suitable delegated authorization flow.

The self-hosted CLI will remain bring-your-own-credentials even after a managed service exists.
