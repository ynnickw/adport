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
