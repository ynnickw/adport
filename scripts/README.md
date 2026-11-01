# Repository tooling

Run commands from the repository root. Prefer the stable pnpm entry points; internal file paths are grouped by responsibility.

| Directory | Responsibility | Entry points |
| --- | --- | --- |
| `repository/` | Public-tree hygiene, Markdown links, DCO checks | `pnpm check:public-tree`, `pnpm check:docs` |
| `release/` | Version preparation, manifest checks, packing, publishing, registry verification | `pnpm check:release`, `pnpm check:packages`, `pnpm release:prepare <version>` |
| `website/` | Static-site generators, editorial source data, generated-page tests | `pnpm check:website` |
| `connectors/` | Production/review tool-catalog comparison and its tests | `node scripts/connectors/check-connector-catalog.mjs <production.json> <review.json> <provider-ids>` |

`pnpm check` runs repository checks, manifest checks, website drift checks, and all script tests. `pnpm test:tooling` runs the colocated `test-*.mjs` suites across these directories.

Application-specific commands stay with their application: Cloud standalone preparation, icon rendering, and the rollback-only waitlist SQL check are in `apps/cloud/scripts/`; the MCP iframe preview generator is in `packages/mcp/scripts/`.

Website HTML is committed because `website/` is deployed directly as a static site. Change the source in `scripts/website/`, regenerate the affected pages, and include the generated diff. One-off screenshots and portal icon exports go under ignored `artifacts/`, rather than into source directories.
