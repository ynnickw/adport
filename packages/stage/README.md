# @adport/stage

Authored product scenes for adport.dev. They show illustrative data and never call a service.

- `kit/` is the [Stageshow](./kit/LICENSE) kit (MIT), copied in unchanged. Restyle it from `src/look.css`, not by editing it.
- `src/` holds the scenes. `src/site.tsx` mounts them into `[data-stage]` slots on the static site.
- `pnpm --filter @adport/stage build:site` rebuilds `website/demos/`, which is committed because the site has no build step.
