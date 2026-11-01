# Releasing Adport

The CLI and all public packages use one version. GitHub releases are the public changelog. Cloud deployments and marketplace submissions have separate lifecycles; a package release does not deploy Cloud, approve a provider application, or publish a connector listing.

## Versioning

Use semantic versions: patches for compatible fixes, minor versions for features, and an explicitly documented minor release for breaking changes while below 1.0. From 1.0 onward, breaking changes require a major version. Preview versions use `X.Y.Z-alpha.N`, `X.Y.Z-beta.N`, or `X.Y.Z-rc.N`.

Public workspaces in `packages/` and the private root manifest stay in lockstep. Private applications keep their own versions and are never published. Internal runtime dependencies use `workspace:*`; pnpm replaces those ranges with exact versions when packing. Agent plugin manifests have their own version and review lifecycle.

Stable packages publish to npm's `latest` tag. Prereleases publish to `next` and are marked as GitHub prereleases.

## Prepare a release pull request

Start from an up-to-date, clean `main` checkout. Choose the next version after checking the [existing releases](https://github.com/ynnickw/adport/releases) and npm registry.

```sh
git switch main
git pull --ff-only
git switch -c release/0.6.2
pnpm release:prepare 0.6.2
```

The command updates the root and public workspace versions and creates `docs/releases/v0.6.2.md`. It does not commit, create a tag, or publish. Write release notes that describe user-visible changes, relevant PRs, upgrade steps, and known provider limits. Replace all template instructions before review.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm check:release v0.6.2
pnpm build
pnpm test
pnpm typecheck
pnpm check:packages
git add package.json packages docs/releases/v0.6.2.md
git commit -s -m "chore: prepare v0.6.2"
git push -u origin release/0.6.2
```

Open a PR against `main` and wait for the repository, DCO, Node.js 22, and Node.js 24 checks. `check:packages` packs every public workspace, checks included files and entry points, installs all tarballs in a temporary home, and exercises the CLI without advertising credentials. Database/HTTP integration tests and live-provider validation must be recorded separately when relevant.

## Tag the reviewed commit

After the release PR is merged and its checks pass, tag its commit on `main`:

```sh
git switch main
git pull --ff-only
git tag -a v0.6.2 -m "Adport v0.6.2"
git push origin v0.6.2
```

The Release workflow:

1. Validates the tag syntax, its ancestry on `main`, version equality across public packages, and the presence of reviewed release notes.
2. Runs repository checks, build, typecheck, tests, and an isolated tarball installation without publishing credentials.
3. Builds public packages and publishes missing versions in dependency order with npm provenance. An unavailable `NPM_TOKEN` fails the job; private workspaces are excluded. Only an explicit registry 404 is treated as an unpublished package.
4. Installs the released CLI from public npm and checks its version, internal dependency versions, fail-closed behavior, and demo reports. Short retries allow for registry propagation.
5. Creates the GitHub release from `docs/releases/<tag>.md` after npm verification succeeds.

Publishing requires a valid, least-privilege `NPM_TOKEN` repository secret with access to `adport` and every public `@adport/*` package. Do not paste it into issues, PRs, or local files. The workflow grants write and OIDC permissions only to its publish job. npm trusted publishing can replace the token once publisher mappings are configured for every package; it is not assumed to be configured by this repository.

## Recover a failed run

Inspect the failed job before retrying. A failed release can leave some npm packages published: npm does not provide a multi-package transaction. Re-run the workflow for the **same immutable tag** using its manual `tag` input; it skips versions the public registry confirms already exist. Authentication, network, or rate-limit lookup errors stop publication.

Never move a published tag or republish an existing npm version. For a code or packaging fix, prepare a new patch release. If publication succeeded but final verification or GitHub release creation failed, repair the external cause and retry the same tag. GitHub release creation is idempotent and preserves existing release notes.

The workflow rebuilds public packages from the validated tag in the publish job. It does not promote build artifacts from CI. No release workflow changes npm dist-tags for previously published versions automatically.

## Verify after publishing

Check the [Release workflow](https://github.com/ynnickw/adport/actions/workflows/release.yml), the GitHub release, and npm's version/tag state. The manually dispatched [Verify published release](https://github.com/ynnickw/adport/actions/workflows/verify-release.yml) workflow can repeat the clean registry install later.

```sh
npm view adport version dist-tags --json
npm install -g adport@0.6.2
adport --version
adport --demo accounts
```

Verify Cloud deployments and live-provider workflows separately when those are in scope. Default smoke checks never mutate a real advertising account.

## Repository settings

CI checks are defined in Git, but branch and tag rules are GitHub settings. Maintainers should require pull requests and passing `Repository checks`, `DCO`, and both `build-test` matrix checks on `main`, and restrict release-tag creation to maintainers. Review the current settings before changing them; workflow files alone do not enforce a merge policy.
