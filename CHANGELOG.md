# Changelog

All notable changes to adport. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); pre-1.0, minor versions may break.

## Unreleased (0.1.0)

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
