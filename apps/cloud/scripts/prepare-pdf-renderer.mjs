import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

// Workers run outside Next's module loader. Ship real package directories instead
// of pnpm links so native bindings and PDF.js's own worker resolve after tracing.
const require = createRequire(import.meta.url);
const app = resolve(import.meta.dirname, '..');
const runtime = join(app, '.pdf-renderer');
rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });
cpSync(join(app, 'lib/cloud/pdf-cover-worker.mjs'), join(runtime, 'worker.mjs'));

const pdf = dirname(require.resolve('pdfjs-dist/package.json'));
for (const file of ['package.json', 'legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs', 'cmaps', 'standard_fonts', 'wasm']) {
  const destination = join(runtime, 'node_modules/pdfjs-dist', file);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(pdf, file), destination, { recursive: true, dereference: true });
}

const canvas = require.resolve('@napi-rs/canvas/package.json');
cpSync(dirname(canvas), join(runtime, 'node_modules/@napi-rs/canvas'), { recursive: true, dereference: true });
const nativeRequire = createRequire(canvas);
const optional = JSON.parse(readFileSync(canvas, 'utf8')).optionalDependencies;
let bindings = 0;
for (const name of Object.keys(optional)) {
  let binding;
  try { binding = nativeRequire.resolve(name); } catch { continue; }
  cpSync(dirname(binding), join(runtime, 'node_modules', name), { recursive: true, dereference: true });
  bindings++;
}
if (!bindings) throw new Error('PDF preview native canvas binding is unavailable');
