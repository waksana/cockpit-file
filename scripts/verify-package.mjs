import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, INSTRUCTIONS_LIMIT, loadSdkPin, sameJson } from './build-identity.mjs';

export async function verifyPackage(root, archive, sourceSha = git(root, ['rev-parse', 'HEAD'])) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.ok((await stat(archive)).size <= 32 * 1024 * 1024, 'Archive exceeds the host package limit');
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  assert.equal((await readFile(`${archive}.sha256`, 'utf8')).trim(), `${sha256}  ${basename(archive)}`);
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    .trim().split('\n').filter(Boolean);
  assert.equal(new Set(names).size, names.length, 'Duplicate archive entries');
  const read = name => execFileSync('tar', ['-xOzf', archive, name], { maxBuffer: 32 * 1024 * 1024 });
  const manifest = JSON.parse(read('cockpit.module.json').toString('utf8'));
  const build = JSON.parse(read('module-build.json').toString('utf8'));
  const expectedManifest = JSON.parse(await readFile(join(root, 'cockpit.module.json'), 'utf8'));
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.ok(sameJson(manifest, expectedManifest), 'Archive manifest differs from this source');
  assert.equal(manifest.id, 'cockpit-file');
  assert.equal(manifest.version, metadata.version);
  assert.equal(basename(archive), `${manifest.id}-${manifest.version}.tgz`);
  assert.equal(build.format, 1);
  assert.equal(build.product, manifest.id);
  assert.equal(build.version, manifest.version);
  assert.equal(build.sourceSha, sourceSha);
  assert.equal(build.node, (await readFile(join(root, '.node-version'), 'utf8')).trim());
  assert.equal(build.node, process.versions.node);
  assert.equal(build.platform, 'linux');
  assert.equal(build.arch, 'x64');
  assert.ok(sameJson(build.sdk, await loadSdkPin(root)), 'Build used a different host SDK');
  assert.ok(Array.isArray(build.files));
  const expected = new Set(['module-build.json']);
  for (const file of build.files) {
    assert.equal(typeof file.path, 'string');
    assert.ok(file.path === 'cockpit.module.json' || file.path === 'LICENSE' || file.path.startsWith('dist/'));
    assert.ok(!/[\\\x00-\x1f]/.test(file.path) && file.path.split('/').every(part => part && part !== '.' && part !== '..'));
    assert.ok(!/\.test\.|\.spec\.|node_modules|\.cockpit-sdk/.test(file.path));
    assert.ok(!expected.has(file.path), 'Duplicate file inventory entry');
    expected.add(file.path);
    const bytes = read(file.path);
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
  if (manifest.instructions !== undefined) {
    const instructions = build.files.find(file => file.path === manifest.instructions);
    assert.ok(instructions, 'Module default instructions must be a packaged file');
    assert.ok(instructions.bytes <= INSTRUCTIONS_LIMIT, 'Module default instructions exceed 16 KiB');
  }
  for (const name of names) if (!name.endsWith('/')) assert.ok(expected.delete(name), `Unexpected package file: ${name}`);
  assert.equal(expected.size, 0, 'An inventoried file is missing');
  return { version: manifest.version, sourceSha, sha256, sdk: build.sdk, files: build.files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archive, sha, ...extra] = process.argv.slice(2);
  if (!archive || extra.length) throw new Error('Usage: verify-package.mjs ARCHIVE [SOURCE_SHA]');
  console.log(JSON.stringify(await verifyPackage(fileURLToPath(new URL('..', import.meta.url)), resolve(archive), sha)));
}
