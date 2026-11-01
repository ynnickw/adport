# Adport website

This directory is the deployment root for the static marketing site at [adport.dev](https://adport.dev). The Cloud application is a separate deployment in `apps/cloud/`. Keep public paths stable when reorganizing tooling.

The homepage and shared CSS/JavaScript are maintained here. Provider pages, resource guides, pricing sections, and shared support markup are generated using source data and templates under `scripts/website/`.

From the repository root:

```sh
node scripts/website/build-support-widget.mjs
node scripts/website/build-provider-pages.mjs
node scripts/website/build-pricing-page.mjs
node scripts/website/build-resource-pages.mjs
pnpm check:website
pnpm test:tooling
```

Commit regenerated HTML with its source changes. These files are required deployment inputs; deleting them would remove public pages. `pnpm check:website` checks drift without modifying files.

Public assets under `fonts/` and `media/`, the app icon, social image, and support portrait are served from this deployment. Preserve their public URLs. Do not put one-off screenshots, tarballs, private data, or local exports here; use ignored `artifacts/` for generated review media.

See [provider-page maintenance](../docs/maintainers/website/provider-landing-pages.md), [resource content](../docs/maintainers/website/resources-content.md), and [repository structure](../docs/maintainers/repository-structure.md).
