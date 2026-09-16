import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedBuild } from './build-identity.mjs';

async function regularTree(directory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error(`Not a build directory: ${directory}`);
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Unsupported build entry: ${path}`);
    if (stat.isDirectory()) await regularTree(path);
    else if (/\.(?:test|spec)\./.test(name)) throw new Error(`Test output must not be packaged: ${path}`);
  }
}

export async function packageModule(root, output) {
  const manifest = JSON.parse(await readFile(join(root, 'cockpit.module.json'), 'utf8'));
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id)
    || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)
    || metadata.version !== manifest.version) throw new Error('Module identity and package version must agree');
  const inputs = [manifest.backend, manifest.frontend?.entry, ...(manifest.frontend?.styles ?? [])];
  for (const file of inputs) {
    if (typeof file !== 'string' || !file.startsWith('dist/') || file.split('/').some(part => !part || part === '.' || part === '..')
      || file.includes('\\')) throw new Error('Module entry must be a safe dist path');
    if (!(await lstat(join(root, file))).isFile()) throw new Error(`Build the module first: missing ${file}`);
  }
  await regularTree(join(root, 'dist'));
  if (!(await lstat(join(root, 'LICENSE'))).isFile()) throw new Error('Missing module license');
  await checkedBuild(root);
  await mkdir(output);
  const name = `${manifest.id}-${manifest.version}.tgz`;
  const archive = join(output, name);
  try {
    const result = spawnSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
      '--hard-dereference', '--transform=s/^\\.module-build\\.json$/module-build.json/',
      '-czf', archive, 'cockpit.module.json', 'dist', 'LICENSE', '.module-build.json'], { cwd: root, stdio: 'pipe' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`tar failed (${result.status}): ${result.stderr.toString()}`);
    await checkedBuild(root);
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(archive)) hash.update(bytes);
    await writeFile(`${archive}.sha256`, `${hash.digest('hex')}  ${name}\n`, { flag: 'wx' });
    return archive;
  } catch (error) {
    try {
      await rm(`${archive}.sha256`, { force: true });
      await rm(archive, { force: true });
      await rmdir(output);
    } catch (cleanup) { throw new AggregateError([error, cleanup], 'Packaging failed and output cleanup failed'); }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/package.mjs [NEW_OUTPUT_DIRECTORY]');
  console.log(await packageModule(fileURLToPath(new URL('..', import.meta.url)), resolve(process.argv[2] ?? 'module-output')));
}
