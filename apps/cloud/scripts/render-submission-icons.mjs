import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Render the existing brand SVG exactly; do not substitute a generated logo.
const require = createRequire(import.meta.url);
const nextRequire = createRequire(require.resolve('next/package.json'));
const sharp = nextRequire('sharp');
const source = await readFile(new URL('../app/icon.svg', import.meta.url));
const output = new URL('../../../docs/submissions/assets/icons/', import.meta.url);
await mkdir(output, { recursive: true });

for (const [name, size] of [['directory', 512], ['composer', 128]]) {
  const path = fileURLToPath(new URL(`adport-${name}.png`, output));
  await sharp(source, { density: 768 }).resize(size, size).png().toFile(path);
  const metadata = await sharp(path).metadata();
  if (metadata.format !== 'png' || metadata.width !== size || metadata.height !== size || !metadata.hasAlpha) {
    throw new Error(`Invalid submission icon: ${name}`);
  }
  console.log(`${name}: ${size}×${size} transparent PNG`);
}
