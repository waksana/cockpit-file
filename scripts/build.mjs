import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { sdkIdentity, sourceIdentity, writeBuildReceipt } from './build-identity.mjs';
import { buildIdentity } from './rolling-identity.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await sdkIdentity(root);
const before = sourceIdentity(root);
await rm(resolve(root, 'dist'), { recursive: true, force: true });
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
  cwd: root, stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
async function removeTests(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await removeTests(path);
    else if (/\.test\.(?:js|d\.ts)$/.test(entry.name)) await rm(path);
  }
}
await removeTests(resolve(root, 'dist'));
await writeFile(resolve(root, 'dist/package.json'), '{"type":"module"}\n');
await mkdir(resolve(root, 'dist/web'), { recursive: true });
await copyFile(resolve(root, 'src/web/styles.css'), resolve(root, 'dist/web/styles.css'));
await copyFile(resolve(root, 'src/instructions.md'), resolve(root, 'dist/instructions.md'));
await mkdir(resolve(root, 'dist/licenses'), { recursive: true });
await copyFile(resolve(root, 'node_modules/lucide-static/LICENSE'), resolve(root, 'dist/licenses/lucide.txt'));
const markdown = await build({
  absWorkingDir: root, entryPoints: ['src/server/markdown.ts'], outfile: 'dist/server/markdown.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node24', metafile: true, legalComments: 'eof',
});
const packages = new Set();
for (const input of Object.keys(markdown.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue;
  let directory = dirname(resolve(root, input));
  while (directory !== root) {
    if ((await readdir(directory)).includes('package.json')) break;
    directory = dirname(directory);
  }
  if (directory === root) throw new Error(`Cannot locate dependency license for ${input}`);
  packages.add(directory);
}
const licenses = [];
for (const directory of [...packages].sort()) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const license = (await readdir(directory)).find(name => /^license(?:\.md|\.txt)?$/i.test(name));
  if (!license) throw new Error(`Missing license for ${manifest.name}`);
  licenses.push(`${manifest.name}@${manifest.version}\n\n${await readFile(resolve(directory, license), 'utf8')}`);
}
await writeFile(resolve(root, 'dist/licenses/markdown.txt'), licenses.join('\n\n---\n\n'));
const identity = await buildIdentity(root);
await writeFile(resolve(root, 'dist/shared/version.js'), `export const displayVersion = ${JSON.stringify(identity.displayVersion)};\n`);
await writeFile(resolve(root, 'dist/build-identity.json'), JSON.stringify(identity, null, 2) + '\n');
await writeBuildReceipt(root, before);
