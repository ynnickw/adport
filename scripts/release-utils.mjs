import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;

export function releaseVersion(value) {
  if (typeof value !== 'string' || value !== value.trim() || !versionPattern.test(value)) throw new Error(`Invalid version: ${value}. Use X.Y.Z or X.Y.Z-{alpha,beta,rc}.N.`);
  return value;
}

export function releaseChannel(version) {
  releaseVersion(version);
  return version.includes('-') ? 'next' : 'latest';
}

export function isNewerVersion(candidate, current) {
  const parse = (value) => releaseVersion(value).split(/[.-]/);
  const a = parse(candidate);
  const b = parse(current);
  for (let index = 0; index < 3; index += 1) {
    if (BigInt(a[index]) !== BigInt(b[index])) return BigInt(a[index]) > BigInt(b[index]);
  }
  if (!a[3] || !b[3]) return Boolean(!a[3] && b[3]);
  const ranks = { alpha: 0, beta: 1, rc: 2 };
  return ranks[a[3]] !== ranks[b[3]] ? ranks[a[3]] > ranks[b[3]] : BigInt(a[4]) > BigInt(b[4]);
}

export function publicPackages(directory = root) {
  const packages = readdirSync(path.join(directory, 'packages')).sort().map((name) => {
    const folder = path.join(directory, 'packages', name);
    return { folder, manifest: readJson(path.join(folder, 'package.json')) };
  }).filter(({ manifest }) => !manifest.private);
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const sorted = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(pkg) {
    const name = pkg.manifest.name;
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Circular package dependency: ${name}`);
    visiting.add(name);
    for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) {
      if (byName.has(dependency)) visit(byName.get(dependency));
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(pkg);
  }
  packages.forEach(visit);
  return sorted;
}

export function checkVersions(directory = root, tag) {
  const manifest = readJson(path.join(directory, 'package.json'));
  const version = releaseVersion(manifest.version);
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`Tag ${tag} must match package version v${version}.`);
  const packages = publicPackages(directory);
  if (!manifest.private || !packages.length) throw new Error('The root must be private and public packages must exist.');
  const names = new Set(packages.map((pkg) => pkg.manifest.name));
  for (const pkg of packages) {
    const data = pkg.manifest;
    if (data.version !== version) throw new Error(`${data.name}: expected version ${version}, got ${data.version}`);
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(data[section] ?? {})) {
        if (names.has(name) && range !== 'workspace:*') throw new Error(`${data.name}: ${name} must use workspace:*`);
      }
    }
  }
  return { version, packages };
}

export function registryHasVersion(result, version) {
  let data;
  try { data = JSON.parse(result.stdout); } catch { /* Report the failed query below. */ }
  if (result.status === 0 && data === version) return true;
  // Network, authentication, and rate-limit failures must never be treated as "not published".
  if (result.status !== 0 && data?.error?.code === 'E404') return false;
  throw new Error('Registry version lookup failed; publication stopped. Check npm connectivity and registry status.');
}
