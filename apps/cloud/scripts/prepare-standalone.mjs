import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');
const serverRoot = resolve(appRoot, '.next/standalone/apps/cloud');
const serverNext = resolve(serverRoot, '.next');

if (!existsSync(resolve(serverRoot, 'server.js'))) {
  throw new Error('Standalone server was not generated. Run this script after next build.');
}

mkdirSync(serverNext, { recursive: true });
cpSync(resolve(appRoot, '.next/static'), resolve(serverNext, 'static'), { recursive: true });
if (existsSync(resolve(appRoot, 'public'))) {
  cpSync(resolve(appRoot, 'public'), resolve(serverRoot, 'public'), { recursive: true });
}
