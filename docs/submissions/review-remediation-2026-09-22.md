# OpenAI review remediation — 2026-09-22

Status: in progress; not resubmitted or approved.

## Authoritative feedback

The rejection email for version 1.0.0 says one or more submitted test cases did
not return the expected result. It does not identify a test, tool, platform, or
observed response. Do not attribute the rejection to OAuth, Meta approval, or
rendering without reproducing it.

## Fresh evidence

- Inspected the rejected version in the publisher organization, including saved
  reviewer instructions, five positive cases, three negative cases, and 20 tools.
- Signed in through the public production login using the submitted dedicated
  reviewer credentials. No MFA, email code, onboarding, or provider login was
  needed. The isolated native review workspace loaded with Meta connected.
- The workspace audit log includes successful validated/applied no-op operations
  shortly before the rejection. This does not identify who ran them or prove all
  reviewer cases passed.
- Reran all five saved positive prompts through the existing Adport development
  connector in ChatGPT web. Inventory returned the designated Meta test account;
  both reporting cases returned honest empty reports; preview displayed a
  PAUSED-to-PAUSED table and Not applied; exact apply displayed Applied and a
  separate read confirmed both status and effective status remained PAUSED.
- Inspected the host confirmation payloads. The preview omitted a pending token;
  apply included the returned token and otherwise identical arguments. No budget
  change or campaign activation was requested or observed.
- All three submitted non-invocation prompts (translation, fictional coffee-shop
  copy, general SEO explanation) returned ordinary text without an Adport call
  or embedded card in the same connected ChatGPT conversation.

## Evidence boundaries

These are current desktop ChatGPT development-connector observations, not proof
of native mobile behavior or equality with the rejected metadata snapshot. No
rejection has yet been reproduced. The test account has no serving history:
empty reports are legitimate but do not prove populated graph functionality.
Never substitute fictional metrics or owner production data as reviewer data.

## Recording and metadata refresh

- The submitted Drive recording is accessible to anyone with its link without
  sign-in. Playback shows the real empty performance report and a compact
  PAUSED-to-PAUSED preview, marked Not applied. It is not evidence of the revised
  independent apply case or the new recommendation case.
- The publisher tool rescan initially stalled because its OAuth popup did not
  appear in the in-app browser. The browser's window-open diagnostic identified
  the intended authorization page. Opening that page and renewing the existing
  reviewer authorization completed the redirect and restored all 20 production
  tools in the saved draft, with their existing justifications preserved.
- The refreshed catalog still labels scoped inventory/report/Meta reads as
  open-world. Current review guidance distinguishes bounded private account
  access from public/open-ended access; this needs a source-level semantic audit
  before changing annotations. It is not an established cause of rejection.

## Annotation correction

Source inspection confirms inventory, reports, audit evaluation, and the four
Meta read tools operate on connected accounts or accessible Pages, not arbitrary
public internet targets. They now explicitly declare `openWorld: false`.
`audit_run` remains modifying because it persists findings. Provider mutations
and recommendation application retain their conservative annotations and the
existing policy gate. No default behavior for other providers was changed.

The actual MCP `tools/list` contract test covers the eight corrected tools and
also asserts that Meta status writes remain non-read-only, destructive, and
open-world. `pnpm build && pnpm test && pnpm typecheck` passed locally on September
22. Environment-gated database/HTTP integration tests remain skipped, not passed.
Production deployment and the final portal rescan are still pending.

Reference: https://developers.openai.com/plugins/deploy/app-review

## Required remediation before resubmission

The portal revision is now an editable saved draft. Its fourth case has been
changed to read the designated campaign, create a fresh preview, wait for an
explicit confirmation, apply identical arguments, and read back the result.
It no longer depends on test 3. The draft explicitly marks the revised flow as
verified in a fresh ChatGPT web conversation on September 22; it has not been
submitted. The revised flow stopped for confirmation, then applied the fresh
token and independently read both statuses back as PAUSED. The preview was also
inspected at narrow browser size: embedded body scroll width equaled its client
width and the comparison table fit inside it. Native mobile-app checks remain
separate and unverified.

The fifth draft case now covers the advertised read-only audit and existing
recommendations instead of duplicating reporting coverage. Its exact prompt was
run in ChatGPT: no findings, zero evaluated accounts because no performance rows
exist, and zero open recommendations. Both embedded empty-state cards rendered;
the assistant did not fabricate opportunities or persist findings. The reviewer
instructions preserve the existing private credentials while replacing old
protocol-only evidence with these dated web results and explicit remaining gates.

- Make each positive test independently executable. In particular, the safe
  apply case must create its own fresh preview rather than require another test
  to run first or rely on a saved expiring token.
- Replace stale draft-readiness notes with dated, accurately bounded evidence.
- Verify the final production tool metadata against the submission snapshot.
- Recheck all negative prompts and mobile UI; do not call a resized desktop test
  a native ChatGPT mobile-app test.
- Cover recommendation/audit behavior promised by the listing, with honest
  empty-state expectations when the designated test resources have no activity.
- Inspect the submitted recording for consistency with the final test setup.
- Submit only after these checks; approval remains an external review outcome.
