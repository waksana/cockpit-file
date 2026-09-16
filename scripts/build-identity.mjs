import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function sourceIdentity(root, strict = false) {
  const sha = git(root, ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Source must have a Git commit');
  const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
  if (strict && dirty) throw new Error('Commit all source changes before packaging');
  return dirty ? null : sha;
}

export async function loadSdkPin(root) {
  const pin = JSON.parse(await readFile(join(root, 'tooling/host-sdk.json'), 'utf8'));
  if (pin.repository !== 'waksana/cockpit' || !/^[a-f0-9]{40}$/.test(pin.commit)
    || !/^\d+\.\d+\.\d+$/.test(pin.version) || pin.apiVersion !== 1
    || Object.keys(pin).sort().join(',') !== 'apiVersion,commit,repository,version') {
    throw new Error('Invalid pinned host SDK identity');
  }
  return pin;
}

export async function inventory(root, roots) {
  const files = [];
  async function visit(name) {
    if (!name || name.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f]/.test(name)) {
      throw new Error('Invalid inventory path');
    }
    const path = join(root, name);
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(`${name}/${child}`);
    } else if (stat.isFile()) {
      const bytes = await readFile(path);
      files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    } else throw new Error(`Inventory contains a link or special file: ${name}`);
  }
  for (const name of roots) await visit(name);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function sdkIdentity(root) {
  const pin = await loadSdkPin(root);
  const saved = JSON.parse(await readFile(join(root, '.cockpit-sdk/pin.json'), 'utf8'));
  const files = await inventory(join(root, '.cockpit-sdk'), ['module-api', 'protocol', 'LICENSE']);
  if (!sameJson(saved.pin, pin) || !sameJson(saved.files, files)) {
    throw new Error('Generated SDK differs from its pin; run the SDK preparation step');
  }
  return pin;
}

export async function writeBuildReceipt(root, before) {
  const sourceSha = sourceIdentity(root);
  if (sourceSha !== before) throw new Error('Source identity changed during the build');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const expectedNode = (await readFile(join(root, '.node-version'), 'utf8')).trim();
  if (process.versions.node !== expectedNode) throw new Error(`Build requires Node ${expectedNode}`);
  const receipt = {
    format: 1, product: 'cockpit-file', version: metadata.version, sourceSha,
    sdk: await sdkIdentity(root), node: process.versions.node, platform: process.platform, arch: process.arch,
    files: await inventory(root, ['cockpit.module.json', 'dist', 'LICENSE']),
  };
  const file = join(root, '.module-build.json');
  await rm(file, { force: true });
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

export async function checkedBuild(root) {
  const sourceSha = sourceIdentity(root, true);
  const file = join(root, '.module-build.json');
  if (!(await lstat(file)).isFile()) throw new Error('Build receipt must be a regular file');
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  const pin = await sdkIdentity(root);
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (receipt.format !== 1 || receipt.product !== 'cockpit-file' || receipt.sourceSha !== sourceSha
    || receipt.version !== metadata.version || receipt.node !== process.versions.node
    || receipt.platform !== process.platform || receipt.arch !== process.arch || !sameJson(receipt.sdk, pin)
    || !sameJson(receipt.files, await inventory(root, ['cockpit.module.json', 'dist', 'LICENSE']))) {
    throw new Error('Build output is stale or modified; rebuild the clean committed source');
  }
  return receipt;
}
