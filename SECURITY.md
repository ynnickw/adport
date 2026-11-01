# Security policy

Adport handles advertising credentials and operations that can affect real spend. Report vulnerabilities privately.

## Report a vulnerability

Email **yannick@adport.dev** with the affected version or commit, deployment mode (local or Cloud), impact, and minimal reproduction steps. Use synthetic identifiers and redact credentials and customer data. Do not open a public issue or attach live credentials.

We aim to acknowledge reports within 72 hours. We will coordinate investigation, a fix, and public disclosure with the reporter. If you discover an exposed credential, revoke or rotate it at the issuing provider; removing it from Git alone does not revoke it.

## Supported versions

Before 1.0, security fixes target the latest release. Upgrade to the latest patched version; older release lines are not maintained separately.

## Security boundaries

- Local credentials are stored under `${ADPORT_HOME:-~/.config/adport}/credentials.json` with mode `0600`. The local CLI and stdio MCP runtime communicate directly with configured providers and contain no telemetry.
- Cloud uses hosted OAuth, encrypted tenant credentials, account-scoped access, and persistent approvals and audit records. Its data handling is described in the [deployment model](docs/deployment-model.md) and [privacy policy](https://adport.dev/privacy).
- Advertising mutations use the shared preview/apply policy gate. Argument mismatch, expired approvals, protected accounts, and budget-cap violations must fail closed. See [write safety](docs/write-safety.md).
- Default tests use mocked provider APIs. Security testing must not change real campaigns, spend, provider permissions, or another tenant's data without explicit authorization.

The public-tree check is a repository hygiene guard, not a full secret scanner or security audit.
