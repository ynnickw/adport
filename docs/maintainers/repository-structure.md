# Repository structure

The repository separates reusable packages from the hosted application and the static marketing site. Keep deployment roots and package boundaries stable unless a change actually needs to alter them.

```text
apps/cloud/                  hosted dashboard, REST, OAuth and remote MCP
  app/                       Next.js routes
  components/                shared application UI
  lib/                       server and client support modules
  scripts/                   application-specific maintenance commands
  test/                      unit and opt-in integration tests
packages/
  core/                      registry, policy, credentials, audit and reports
  {provider}/                one advertising-platform adapter per workspace
  cli/                       terminal adapter over the shared registry
  mcp/                       stdio adapter and embedded MCP views
plugins/adport/               distributable agent plugin and its own submission copy
supabase/                    local database configuration and migration history
website/                     independently deployed static site and public assets
scripts/
  repository/                source-tree and contributor checks
  release/                   package release tooling and tests
  website/                   site generators, source content and tests
  connectors/                review-catalog comparison and tests
docs/
  providers/                 individual provider and hosted-onboarding guides
  cloud/                     hosted application setup and operations
  maintainers/               releases, website maintenance and connector reviews
  releases/                  reviewed package release notes
artifacts/                   ignored generated screenshots and icon exports
```

User-facing cross-provider guides remain at the top of `docs/`: provider connections, reporting semantics, write safety, and Apple campaign setup. `docs/README.md` is the navigation entry point. Maintainer-only instructions belong under `docs/maintainers/`; dated observations belong in the relevant archive rather than current setup guides.

## What belongs in Git

Commit source code, tests, lockfiles, migrations, example configuration, required public assets, and reproducible static pages that are deployed directly. Provider packages follow the same `src/`, `test/`, manifest, README, and TypeScript configuration layout. Add a subfolder when it expresses a real boundary; small provider adapters do not need identical internal file counts.

Do not commit local credentials, database state, `.env.local`, dependencies, compiler caches, tarballs, or generated submission screenshots. The repository ignores these and runs a public-tree guard. Historical in-host captures remain in the connector archive because they record verification evidence that cannot be recreated by rendering a fixture.

## Files that can look redundant

- Database migrations are ordered history used by existing installations. Retain applied migrations.
- Generated HTML in `website/` is a deployment input, with generator drift checked in CI.
- The support portrait and fonts occur in both the Cloud and website deployment roots because both serve their own public assets. The portrait generator/test checks that its copies match.
- `apps/cloud/AGENTS.md` and its `CLAUDE.md` include are generated framework guidance; deleting them causes development tooling to recreate them.
- The reviewer walkthrough under `apps/cloud/public/review/` has a deployed URL used for review. A missing source-code import does not establish that a public asset is unused.
- Plugin submission instructions and hosted connector review instructions target different packages and review flows; keep them with their owning artifacts.

## Before moving or deleting files

Update imports, package scripts, workflows, documentation links, and generated-page source comments together. Prefer pnpm commands in contributor instructions so internal script moves do not change the public development interface. Run `pnpm check` and `actionlint` after tooling moves, and `pnpm check:packages` after release-tooling changes. Re-run application checks if application code changes.

A file with no import may still be a public URL, framework convention, migration, or review artifact. Confirm its owner and purpose before removing it. Source deletion also does not erase earlier Git history.
