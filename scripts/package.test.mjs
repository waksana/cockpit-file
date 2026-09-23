import assert from 'node:assert/strict';
import { writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { packageModule } from './package.mjs';
import { releaseFixture as fixture, commitFixture } from './test-support/release-fixture.mjs';
import { verifyPackage } from './verify-package.mjs';

test('module archive includes its fixed manifest, compiled code and license only', async t => {
  const f = await fixture(t);
  const archive = await packageModule(f.root, f.output);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.match(entries, /cockpit\.module\.json/);
  assert.match(entries, /dist\/server\.js/);
  assert.match(entries, /LICENSE/);
  assert.match(entries, /module-build.json/);
  assert.doesNotMatch(entries, /private-fixture|package\.json/);
  assert.match(await readFile(`${archive}.sha256`, 'utf8'), /^[a-f0-9]{64}  cockpit-file-0\.1\.0\.tgz\n$/);
  const repeated = await packageModule(f.root, join(f.root, 'second-output'));
  assert.deepEqual(await readFile(repeated), await readFile(archive));
  await assert.rejects(packageModule(f.root, f.output), { code: 'EEXIST' });
  assert.equal((await verifyPackage(f.root, archive)).sourceSha, f.sha);
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

test('frontend entry and styles must exist inside declared asset roots and ship in the archive', async t => {
  const f = await fixture(t);
  const file = join(f.root, 'cockpit.module.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.frontend.styles = ['dist/missing.css'];
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(packageModule(f.root, f.output), { code: 'ENOENT' });
  manifest.frontend.styles = ['dist/web.css'];
  manifest.frontend.assets = ['dist/web.js'];
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(packageModule(f.root, f.output), /declared asset roots/);
  manifest.frontend.assets = ['dist'];
  await writeFile(file, JSON.stringify(manifest));
  const archive = await packageModule(f.root, f.output);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.match(entries, /dist\/web\.js/);
  assert.match(entries, /dist\/web\.css/);
  await verifyPackage(f.root, archive);
});

test('packaging rejects dirty source, stale builds, SDK changes and tampered dist', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'private-fixture.txt'), 'Changed source');
  await assert.rejects(packageModule(f.root, f.output), /Commit all source/);
  commitFixture(f.root);
  await assert.rejects(packageModule(f.root, f.output), /stale or modified/);
  await f.receipt();
  await writeFile(join(f.root, 'dist/web.js'), 'Changed output');
  await assert.rejects(packageModule(f.root, f.output), /stale or modified/);
  await f.receipt();
  await writeFile(join(f.root, '.cockpit-sdk/protocol/package.json'), '{"version":"changed"}');
  await assert.rejects(packageModule(f.root, f.output), /SDK differs/);
});

test('default instructions must be a packaged dist file within 16 KiB', async t => {
  const f = await fixture(t);
  const file = join(f.root, 'cockpit.module.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.instructions = 'dist/instructions.md';
  await writeFile(file, JSON.stringify(manifest));
  commitFixture(f.root);
  await f.receipt();
  await assert.rejects(packageModule(f.root, f.output), { code: 'ENOENT' });
  await writeFile(join(f.root, 'dist/instructions.md'), 'x'.repeat(16 * 1024 + 1));
  await f.receipt();
  await assert.rejects(packageModule(f.root, f.output), /exceed 16 KiB/);
  await writeFile(join(f.root, 'dist/instructions.md'), 'Link files as Markdown.\n');
  await f.receipt();
  const archive = await packageModule(f.root, f.output);
  assert.match(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }), /dist\/instructions\.md/);
  await verifyPackage(f.root, archive);
  for (const instructions of ['instructions.md', 'dist/../instructions.md']) {
    manifest.instructions = instructions;
    await writeFile(file, JSON.stringify(manifest));
    await assert.rejects(packageModule(f.root, join(f.root, 'other-output')), /safe dist path/);
  }
});
