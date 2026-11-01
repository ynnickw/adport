import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { withSupport } from './website-support.mjs';

const site = fileURLToPath(new URL('../website/', import.meta.url));
const check = process.argv.includes('--check');
const portrait = await readFile(new URL('../apps/cloud/public/yannick-support.png', import.meta.url));
const websitePortrait = path.join(site, 'yannick-support.png');
const pages = (await readdir(site, { recursive: true })).filter(file => file.endsWith('.html'));
let stale = false;
if (!(await readFile(websitePortrait).catch(() => Buffer.alloc(0))).equals(portrait)) {
  if (check) { console.error('Website support portrait is stale.'); stale = true; }
  else await writeFile(websitePortrait, portrait);
}
for (const page of pages) {
  const file = path.join(site, page);
  const current = await readFile(file, 'utf8');
  const next = withSupport(current);
  if (next === current) continue;
  if (check) { console.error(`Support widget is stale: website/${page}`); stale = true; }
  else await writeFile(file, next);
}
if (stale) process.exitCode = 1;
else console.log(`${check ? 'Verified' : 'Added'} support widget on ${pages.length} public pages.`);
