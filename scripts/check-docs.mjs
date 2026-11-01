import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './release-utils.mjs';

const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '*.md'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))];
const broken = [];
for (const file of files) {
  if (!existsSync(path.join(root, file))) continue;
  const content = readFileSync(path.join(root, file), 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const link = match[1].replace(/^<|>$/g, '');
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(link)) continue;
    const target = decodeURIComponent(link.split(/[?#]/)[0]);
    if (target && !existsSync(path.resolve(root, path.dirname(file), target))) broken.push(`${file}: ${link}`);
  }
}
if (broken.length) {
  console.error(`Broken local documentation links:\n${broken.join('\n')}`);
  process.exit(1);
}
console.log(`Local documentation links valid (${files.length} Markdown files).`);
