# Anthropic connector directory submission — Adport

This file is the copy-and-checklist source for the Claude Connector Directory submission. Keep reviewer credentials and customer data out of the repository.

## Directory listing

- **Name:** Adport
- **Description:** Connect your advertising accounts once, then analyze performance and safely preview or apply governed changes from Claude.
- **MCP endpoint:** `https://app.adport.dev/mcp`
- **Transport:** Streamable HTTP
- **Authentication:** OAuth 2.1 authorization code with PKCE and dynamic client registration
- **OAuth callback support:** Claude's remote MCP callback must be accepted by the dynamic registration flow.
- **Developer:** Yannick Westermann Labs
- **Website:** `https://adport.dev`
- **Support:** `https://adport.dev/support`
- **Privacy:** `https://adport.dev/privacy`
- **Terms:** `https://adport.dev/terms`

## Three primary use cases

1. **Scoped inventory:** `List every ad account this Adport workspace can access, grouped by provider.`
2. **Cross-provider reporting:** `Compare campaign spend, clicks, conversions, and ROAS for the last 7 days. Call out currency or attribution limitations.`
3. **Governed optimization:** `Find the strongest budget opportunity and create a preview only. Explain every policy coercion and do not apply it.`

Additional reviewer prompt:

4. `Show open recommendations, then explain which evidence supports the highest-priority one.`

## Expected Claude experience

Adport implements the open MCP Apps extension. Compatible Claude surfaces render the same inline Adport account, performance, recommendation, and guarded-change cards used in ChatGPT. Hosts without MCP Apps support receive complete JSON text plus structured content; all tools remain independently useful without the view.

The view never directly calls an advertising provider. It renders the result of an already-authorized Adport tool, so account scoping and the policy engine remain authoritative.

## Submission media

Sanitized visual baselines generated from the exact MCP App resource:

- [Scoped account inventory](./assets/mcp-accounts.png)
- [Cross-provider performance](./assets/mcp-report.png)
- [Policy-gated operation preview](./assets/mcp-operation.png)

Regenerate with `pnpm --filter @adport/mcp render:submission-previews`. Replace or supplement these with an in-Claude capture before the final directory submission.

## Reviewer account

Create one dedicated reviewer login containing synthetic or non-sensitive sample data with:

- at least two scoped sample accounts;
- campaign rows with spend, impressions, clicks, conversions, and conversion value;
- at least one open recommendation;
- one write-capable demo campaign that can safely exercise preview/apply without enabling spend;
- OAuth consent for `tools:read tools:write`.

Share the login only through Anthropic's private review field. Never include passwords or tokens in source, screenshots, or public documentation.

## Policy mapping

- Tool names, titles, descriptions, and input schemas are explicit and narrow.
- `readOnlyHint`, `destructiveHint`, and `openWorldHint` reflect runtime behavior.
- Advertising mutations pass the policy engine; the reviewer workspace must explicitly use preview-required policy. Findings/audit persistence is a separate mutation class.
- Adport owns and operates the submitted endpoint and public domain.
- Public privacy, support, terms, and deletion instructions are available.
- The MCP App declares an empty external network CSP and requests no device permissions.
- The connector does not advertise an approval, provider capability, or account access that the runtime cannot verify.

## Final submission checklist

- [ ] Fresh Claude Web/Desktop connection completes OAuth and discovers tools.
- [ ] Fresh Claude Code connection completes OAuth and refreshes successfully.
- [ ] The three required directory prompts work with the reviewer account.
- [ ] MCP Apps cards render on a compatible Claude surface; text/structured fallback is checked separately.
- [ ] A preview proves that no write occurs on the first call.
- [ ] An apply test uses only a paused/non-spending demo resource.
- [ ] Tool annotations and descriptions match actual behavior.
- [ ] Support, privacy, terms, and deletion paths are reachable without login.
- [ ] Yannick gives fresh confirmation immediately before the final directory submission.

## Current portal and asset requirements

As checked September 5, 2026, remote MCP submissions use Claude's organization submission portal and require Team/Enterprise plus directory-management access (Owner on Team). Interactive listings require 3–5 PNG screenshots, at least 1000px wide, cropped to the app response, with prompts supplied separately. Do not purchase a plan or assume portal access is already available. See [Anthropic's submission guide](https://claude.com/docs/connectors/building/submission).

The current [pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria) also calls for testing every tool in MCP Inspector and Claude, populated reviewer credentials, explicit annotations, and API references for freeform queries. Its wording requires `destructiveHint=true` for modifying tools; reconcile this with Adport's current removal-only destructive mapping before claiming compliance. Do not mask a modifying tool as read-only just because its first call previews.

The checked-in screenshots need regeneration for the currency/error corrections. Real Claude execution, OAuth refresh, complete tool coverage, and reviewer provisioning remain unverified; see [validation status](./validation-status.md).
