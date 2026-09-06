# Production connector release gate

The owner requires **real, production-ready connectors only**. Do not submit the
current synthetic-reviewer catalog as Adport's public product. Synthetic tests
remain useful UI/policy regression evidence, not provider approval or production
API evidence. This gate applies to both the OpenAI and Claude submissions.

## Current blocker (September 7, 2026)

The OpenAI draft was inspected again: its saved snapshot contains seven common
tools plus `demo_list_campaigns` and `demo_set_budget`. No native provider tools
are present. Domain verification and saved annotation explanations do not fix
that omission. The draft has not been submitted.

The cloud runtime assembles native tools from each tenant's connected providers;
the synthetic-reviewer branch deliberately supplies a different runtime. MCP
registration currently uses that runtime's registry directly. Consequently, a
single tenant scan is not a stable catalog for the full public connector.

[OpenAI's review requirements](https://developers.openai.com/plugins/deploy/app-review)
state that the published plugin uses the reviewed metadata snapshot while calls
and UI resources use the live server. Catalog changes require a new scan/review.
Do not simply scan with one real account and assume all other providers are covered.

A network-disabled audit of the built native tool factories found 94 definitions:

| Provider | Native tools |
| --- | ---: |
| Google | 15 |
| Meta | 13 |
| TikTok | 9 |
| Apple | 15 |
| Microsoft | 8 |
| Reddit | 9 |
| Snapchat | 4 |
| Spotify | 6 |
| Pinterest | 4 |
| LinkedIn | 5 |
| X | 6 |

These counts establish implementation breadth only. They do **not** establish
public API approval, usable credentials, production correctness, or launch scope.

## Required before either submission

1. Establish the explicit release provider set from current public-app approvals
   and real hosted API tests. Connection badges and an owner's working login are
   not sufficient evidence that unrelated production users can authorize the app.
2. Resolve the tenant-dependent catalog: reuse the shared tool definitions for
   stable release metadata, while executing every call against the authenticated
   tenant's actual runtime, scopes, enabled accounts and policy. No placeholders,
   inert providers, or reviewer-only implementations may masquerade as live tools.
3. Scan the exact intended catalog, with no demo tools and no unreleased provider
   tools. Also compare server instructions and linked UI resource metadata/CSP,
   which are not part of a tools/list export. Preserve account isolation and
   plan/scope denials. Re-scan after metadata changes and re-enter the portal
   explanations that a new scan clears.
4. Provide isolated reviewer access to the actual advertised native workflows.
   Use provider-supported non-spending test resources where available; never
   silently attach customer accounts, widen account access, or activate campaigns.
   The current synthetic login is not a substitute for this coverage.
5. Verify each advertised tool, OAuth refresh beyond expiry/concurrent sessions,
   scope rejection, partial provider failures, accurate graphs and exact
   before/after previews in the real hosts. Only claim apply coverage where an
   authorized non-spending native test actually ran and was independently read back.
6. Replace synthetic final-review prompts/media with genuine native execution
   evidence, then complete the private review fields and required confirmations.
   OpenAI listing screenshots are optional per its review guide; the video and
   complete functional evidence still matter. Claude has separate requirements.

## Reproducible catalog comparison

Save complete SDK `tools/list` results for production and the review connection
outside the repository. Collect every page and retain full tool metadata. These
files must contain only metadata, not tokens, headers, account data or tool results.

```sh
node scripts/check-connector-catalog.mjs \
  /path/to/production-tools.json /path/to/review-tools.json \
  VERIFIED_PROVIDER_IDS
```

Replace `VERIFIED_PROVIDER_IDS` with the comma-separated release set established
in step 1, not all installed packages. The check rejects demo tools, missing native
providers, out-of-scope providers, incomplete exports, duplicates, missing explicit
annotations and any saved tool metadata differences. It compares schemas,
annotations, tool security metadata and UI references, not just tool counts.

A passing result means **metadata parity only**, not production readiness. The
checker cannot authenticate the origin of manually supplied files or prove app
approval, authorization boundaries, refresh behavior, or live execution. Keep
those independent evidence gates. Its regression suite runs in CI:

```sh
node --test scripts/test-connector-catalog.mjs
```

## Browser access update

The real owner signed in successfully through Google in the Adport Chrome
profile on September 7. The dashboard visibly identifies `ynnickw20@gmail.com`.
The Accounts page currently enables Meta Adport Test, Microsoft, and Snapchat;
the other accounts remain disabled for agent access. This is not public provider
approval evidence. The in-app browser's old synthetic session has been signed out;
the ChatGPT connector must be authorized with the real account and rescanned.
Do not convert the retired reviewer into an owner with real customer access.
A separate existing Codex hosted connection
provides verified real Google/Reddit reads (see the validation log), but it is not
the ChatGPT review grant and does not establish public approval or write coverage.
