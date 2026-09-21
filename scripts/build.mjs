import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sdkIdentity, sourceIdentity, writeBuildReceipt } from './build-identity.mjs';

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
await mkdir(resolve(root, 'dist/web/next'), { recursive: true });
await copyFile(resolve(root, 'src/web/next/styles.css'), resolve(root, 'dist/web/next/styles.css'));
await mkdir(resolve(root, 'dist/licenses'), { recursive: true });
await copyFile(resolve(root, 'node_modules/lucide-static/LICENSE'), resolve(root, 'dist/licenses/lucide.txt'));
await writeBuildReceipt(root, before);
