# Changelog

All notable changes to adport. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); pre-1.0, minor versions may break.

## 0.5.2 — 2026-08-15

### Fixed
- Apple Ads Platform API v1 ad-group creation now uses the documented `pricingModel` and `bidStrategy.bid` shape instead of legacy bid fields.
- Apple ad-account creation no longer sends an account-scoped context header.
- Campaign creation matches Apple's live-proven App Store Search request contract.

### Added
- Typed, policy-guarded Apple ad-group and keyword creation tools with paused-by-default creation and bid-delta enforcement.

### Tested
- Apple v1 wire contracts now have 19 provider tests; the complete 147-test workspace, build, and typecheck gates pass.

## 0.5.1 — 2026-08-15

### Fixed
- Apple App Store campaign creation now sends `APPSTORE_SEARCH_RESULTS` as the `supplyPlacement` and includes the required `MANUAL_CPT`/`TAP` bid strategy, matching Apple Ads Platform API v1.

## 0.5.0 — 2026-08-15

### Added
- Complete Apple Ads Platform API v1 operation coverage, including App Store and Apple Maps resources, reports, insights, suggestions, recommendations, shared budgets, bulk keyword operations, and creative asset uploads.
- Guarded Apple tools for recommendation actions, SHA-256-bound asset uploads, bids, and shared budgets.

### Changed
- Apple Ads now uses `api.ads.apple.com/v1`, v1 envelopes, and ad-account context instead of the retired Campaign Management API v5 wire contract.
- Apple reads and writes retain the shared policy preview, pending-operation, budget-delta, and audit protections.

### Tested
- Apple v1 request and response contracts are covered by 17 provider tests and live read-only account, campaign, and report checks.

## 0.4.0 — 2026-08-13

### Added
- Reddit Ads API v3 provider with local OAuth, account discovery, normalized reporting, campaign creation, status controls, budget updates, and advanced API tools.
- Provider-native read and guarded create/update/delete tools for Google, Meta, TikTok, Apple, Microsoft, and Reddit.

### Changed
- Local provider onboarding and documentation now cover Reddit and clearly separate bring-your-own credentials from the future Adport Cloud broker.
- Provider-native mutations share the normal dry-run, pending-operation, policy, and audit path.

### Security
- Google user-data handling, retention, sharing, and revocation disclosures are documented explicitly.

## 0.3.0 — 2026-08-09

### Added
- Explicit `--demo` and `ADPORT_DEMO=true` modes for isolated synthetic accounts and `mock_*` tools.
- `adport disconnect <provider>` for removing locally stored provider credentials.
- Shared local/BYO onboarding guidance for Google, Meta, TikTok, Apple, and Microsoft.

### Changed
- Runtimes with no connected provider now fail closed with `NOT_CONNECTED` instead of silently substituting mock data.
- Provider wizards distinguish local credentials from the future Adport Cloud OAuth broker and explain provider-owned consent or review notices.

### Security
- Google desktop OAuth now uses PKCE and state validation.
- Microsoft OAuth retains PKCE and now validates state on the localhost callback.
- Demo mode never loads configured real providers.

## 0.2.0 — 2026-08-08

### Added
- Public `adport.dev` landing page with privacy and terms pages.
- Public-tree guard in CI and release workflows so internal planning paths cannot be published accidentally.
- Explicit documentation of the current self-hosted/BYO-credentials model and the boundary for a future hosted OAuth broker.
- Live connection verification for Google Ads, Apple Ads, and Microsoft Advertising.

### Fixed
- Microsoft desktop OAuth now advertises the registered `http://localhost` loopback host while retaining PKCE and a local ephemeral port.
- Apple campaign reporting orders by the supported `campaignId` field instead of the rejected `countryOrRegion` field.

### Security
- Internal launch plans, research, agent context, and generated marketing material are excluded from the public tree.
- Security reports now use `yannick@adport.dev`.

## 0.1.0 — 2026-08-07

### Added
- **Five providers**, all with doc-faithful mocked test suites:
  - Google Ads (REST v24): GAQL search, campaign/ad-group/keyword/RSA writes with server-side `validate_only`, bidding tools (CPC ceiling, strategy switch)
  - Meta Ads (Graph v26.0): insights, campaign/ad-set management with `execution_options=["validate_only"]`
  - TikTok Ads (Business API v1.3): sync reporting, campaign management, sandbox support
  - Apple Ads (Campaign Management v5): ES256-JWT OAuth, campaigns + reporting (Platform-API migration boundary prepared)
  - Microsoft Advertising (REST v13): async CSV reporting, campaign management, sandbox with universal dev token
- **Policy engine**: two-step validate→apply writes with pending-operation tokens, paused-by-default creation, budget-delta caps, protected accounts, append-only audit log (+ `adport audit note` for external changes)
- **Recommendation harness** (OPA pattern): pluggable rule packs over normalized cross-platform state, persisted findings with open/dismissed/applied lifecycle, `recommendation_apply` routing through the policy gate; starter `core-performance` pack (zero-conversion spend, low CTR, CPA outliers, negative ROAS). No gameable score by design.
- **MCP server** (stdio) + **CLI** over one shared tool registry; guided `adport connect <provider>` wizards for all five providers; `adport doctor`
- Cross-platform normalized `report` tool (spend/clicks/conversions/ROAS/... unified across all providers)
