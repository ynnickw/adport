// Builds the scenes into website/demos. adport.dev is a static site with no build
// step and a strict CSP, so the bundle and its stylesheet are committed like its
// other assets. Run `pnpm --filter @adport/stage build:site` after changing a scene.
import { build } from 'esbuild';

await build({
  entryPoints: { stage: 'src/site.tsx' },
  outdir: '../../website/demos',
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022', 'safari16'],
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'linked',
  logLevel: 'info',
});
