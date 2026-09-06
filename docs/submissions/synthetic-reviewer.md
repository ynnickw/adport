# Retired synthetic reviewer

The hosted synthetic reviewer has been removed. Do not provision a new demo
workspace or submit a demo tool catalog. The production MCP transport rejects
synthetic runtimes and demo/mock tools before advertising any tools.

Existing IDs in `ADPORT_SYNTHETIC_REVIEWER_ORGANIZATION_IDS` remain a denylist:
their sessions return 403 without loading provider credentials or synthetic state.
Keep those IDs configured until the old grants are retired; never repurpose a
reviewer identity into an owner of real customer data. Stored historical state is
retained, not deleted by this change.

Local, network-free test fixtures remain for automated regression tests only.
Use the real owner's normal OAuth flow for production testing. An installed
ChatGPT connector or saved submission may retain the old scanned catalog until
it is reauthorized with the correct workspace and rescanned. Such stale demo
tools cannot execute against the production server after deployment.

See [production readiness](./production-readiness.md) for the actual release gates.
