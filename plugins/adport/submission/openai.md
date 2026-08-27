# OpenAI public plugin submission

## Listing

- **Name:** Adport
- **Short description:** Operate paid media with structural safety rails.
- **Category:** Business
- **Website:** https://adport.dev
- **Support:** mailto:yannick@adport.dev
- **Privacy:** https://adport.dev/privacy
- **Terms:** https://adport.dev/terms
- **MCP URL type:** Universal
- **Production MCP URL:** https://app.adport.dev/mcp
- **Authentication:** OAuth 2.1 with S256 PKCE

Long description:

> Connect approved advertising accounts once, then use normalized cross-platform reporting, account audits, recommendations, and preview-before-apply campaign operations from ChatGPT or Codex. Adport enforces active-account boundaries, budget policy, paused campaign creation, expiring pending operations, and a persistent audit trail.

## Starter prompts

1. Review my ad accounts and identify the highest-impact issue.
2. Compare campaign performance across my connected platforms.
3. Preview a safe fix for the most urgent finding.

## Positive review cases

1. **Account inventory:** Ask to list connected accounts. Expect only active workspace accounts, with provider, id, name, currency, and status.
2. **Cross-platform report:** Ask for spend, clicks, conversions, and ROAS for the last seven days. Expect normalized rows, provider attribution, and no mutation.
3. **Partial provider failure:** Use a demo provider fixture that fails while another succeeds. Expect successful rows plus a clearly identified partial error.
4. **Write preview:** Ask to create or change a campaign. Expect a preview, coercions, budget deltas, expiry, and pending id; no provider mutation.
5. **Exact apply:** Explicitly approve the preceding preview. Expect only the hash-identical pending operation to apply and return resource ids.

## Negative review cases

1. **No explicit approval:** After a preview, ask an unrelated question. Expect no second write call and no applied change.
2. **Account outside scope:** Request a report or mutation for a discovered but inactive account. Expect a policy rejection that directs the user to enable that exact account.
3. **Changed or expired preview:** Reuse a pending id with modified arguments or after expiry. Expect rejection and no provider mutation.

## Submission gate

- [ ] Verified publisher identity matches Yannick Westermann Labs and adport.dev.
- [ ] Production domain and MCP endpoint are live over HTTPS.
- [ ] A fully featured reviewer account contains deterministic sample data and needs no inaccessible MFA.
- [ ] Every submitted provider uses an approved production application and authorized API access.
- [ ] Tool annotations are scanned and confirmed (`readOnlyHint`, `destructiveHint`, `openWorldHint`).
- [ ] The five positive and three negative cases pass against production.
- [ ] Plugin responses contain no credentials, debug payloads, unnecessary identifiers, checkout, pricing, or upgrade promotion.
