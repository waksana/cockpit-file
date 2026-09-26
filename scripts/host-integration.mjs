import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollingIdentity } from './rolling-identity.mjs';

export async function hostIntegration(root) {
  const pin = JSON.parse(await readFile(join(root, 'tooling/host-integration.json'), 'utf8'));
  if (pin.repository !== 'waksana/cockpit' || !/^[a-f0-9]{40}$/.test(pin.commit)
    || Object.keys(pin).sort().join(',') !== 'commit,repository') {
    throw new Error('Invalid pinned integration host');
  }
  const manifest = JSON.parse(await readFile(join(root, 'cockpit.module.json'), 'utf8'));
  if (manifest.id !== 'cockpit-file' || !/^\d+\.\d+\.\d+(?:-dev)?$/.test(manifest.version)) {
    throw new Error('Invalid module release identity');
  }
  const version = process.env.ROLLING_SEQUENCE
    ? rollingIdentity(process.env.ROLLING_SEQUENCE, process.env.ROLLING_SOURCE_SHA).version : manifest.version;
  return { ...pin, archive: `${manifest.id}-${version}.tgz` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: host-integration.mjs');
  for (const [key, value] of Object.entries(await hostIntegration(fileURLToPath(new URL('..', import.meta.url))))) {
    console.log(`${key}=${value}`);
  }
}
