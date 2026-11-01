## Problem and resulting behavior

<!-- Explain the trigger, the change, and why it helps. Link the related issue. -->

## Validation

<!-- List checks actually run, results, and skipped integration/provider checks. -->

## Checklist

- [ ] Human-authored commits have a DCO sign-off (`git commit -s`)
- [ ] `pnpm check`, `pnpm build`, `pnpm test`, and `pnpm typecheck` pass
- [ ] User-facing behavior and compatibility changes are documented
- [ ] Provider writes preserve the shared policy gate, exact approval binding, budget caps, paused creation, and audit logging (if applicable)
- [ ] Provider tests assert the outgoing API contract; live verification is identified separately (if applicable)
- [ ] No credentials, account data, or private request output are included
