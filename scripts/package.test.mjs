import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { packageModule } from './package.mjs';

async function fixture(t) {
  const root = await mkdtemp(new URL('../node_modules/package-fixture-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'cockpit.module.json'), JSON.stringify({
    apiVersion: 1, id: 'cockpit-file', version: '0.1.0', backend: 'dist/server.js',
    frontend: { entry: 'dist/web.js', styles: ['dist/web.css'], assets: ['dist'] },
  }));
  await writeFile(join(root, 'package.json'), '{"version":"0.1.0"}');
  await writeFile(join(root, 'LICENSE'), 'Synthetic fixture license');
  for (const file of ['server.js', 'web.js', 'web.css']) await writeFile(join(root, 'dist', file), 'Synthetic build input');
  await writeFile(join(root, 'private-fixture.txt'), 'Must not ship');
  return { root, output: join(root, 'output') };
}

test('module archive includes its fixed manifest, compiled code and license only', async t => {
  const f = await fixture(t);
  const archive = await packageModule(f.root, f.output);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.match(entries, /cockpit\.module\.json/);
  assert.match(entries, /dist\/server\.js/);
  assert.match(entries, /LICENSE/);
  assert.doesNotMatch(entries, /private-fixture|package\.json/);
  assert.match(await readFile(`${archive}.sha256`, 'utf8'), /^[a-f0-9]{64}  cockpit-file-0\.1\.0\.tgz\n$/);
  const repeated = await packageModule(f.root, join(f.root, 'second-output'));
  assert.deepEqual(await readFile(repeated), await readFile(archive));
  await assert.rejects(packageModule(f.root, f.output), { code: 'EEXIST' });
});

test('module packaging rejects linked files, tests and version drift', async t => {
  const f = await fixture(t);
  const link = join(f.root, 'dist', 'linked.js');
  await symlink('../private-fixture.txt', link);
  await assert.rejects(packageModule(f.root, f.output), /Unsupported build entry/);
  await rm(link);
  const testFile = join(f.root, 'dist', 'unit.test.js');
  await writeFile(testFile, 'Must not ship');
  await assert.rejects(packageModule(f.root, f.output), /Test output/);
  await rm(testFile);
  await writeFile(join(f.root, 'package.json'), '{"version":"0.2.0"}');
  await assert.rejects(packageModule(f.root, f.output), /version must agree/);
});
