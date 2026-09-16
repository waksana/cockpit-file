import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, inventory, loadSdkPin, sameJson } from './build-identity.mjs';

export async function prepareSdk(root, host) {
  const pin = await loadSdkPin(root);
  if (git(host, ['rev-parse', 'HEAD']) !== pin.commit || git(host, ['status', '--porcelain=v1', '--untracked-files=normal'])) {
    throw new Error('SDK source must be the clean, exact pinned host commit');
  }
  for (const name of ['module-api', 'protocol']) {
    const metadata = JSON.parse(await readFile(join(host, 'packages', name, 'package.json'), 'utf8'));
    if (metadata.version !== pin.version) throw new Error('Host SDK package version does not match the pin');
  }
  const temporaryParent = join(root, 'node_modules');
  await mkdir(temporaryParent, { recursive: true });
  const temporary = await mkdtemp(join(temporaryParent, '.sdk-prepare-'));
  const staging = join(temporary, 'sdk');
  const target = join(root, '.cockpit-sdk');
  try {
    execFileSync(process.execPath, [join(host, 'scripts/export-module-api.mjs'), staging], { cwd: root, stdio: 'pipe' });
    const files = await inventory(staging, ['module-api', 'protocol', 'LICENSE']);
    let exists = false;
    try {
      const stat = await lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SDK target must be a generated directory, not a link');
      exists = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists) {
      const previous = await inventory(target, ['module-api', 'protocol', 'LICENSE']);
      if (!sameJson(previous, files)) throw new Error('Existing generated SDK differs; remove only .cockpit-sdk and prepare it again');
    } else await rename(staging, target);
    await writeFile(join(target, 'pin.json'), JSON.stringify({ pin, files }, null, 2) + '\n');
    return pin;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [command, host, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Usage: sdk.mjs info | prepare PINNED_HOST_SOURCE');
  if (command === 'info' && !host) {
    const pin = await loadSdkPin(root);
    const manifest = JSON.parse(await readFile(join(root, 'cockpit.module.json'), 'utf8'));
    if (manifest.id !== 'cockpit-file' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid module release identity');
    console.log(`repository=${pin.repository}\ncommit=${pin.commit}\narchive=${manifest.id}-${manifest.version}.tgz`);
  } else if (command === 'prepare' && host) console.log(JSON.stringify(await prepareSdk(root, resolve(host))));
  else throw new Error('Usage: sdk.mjs info | prepare PINNED_HOST_SOURCE');
}
