import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import { releaseFixture } from './test-support/release-fixture.mjs';
import { packageModule } from './package.mjs';
import { checkRelease, checkTagTarget } from './check-release.mjs';
import { verifyPackage } from './verify-package.mjs';

test('release checks bind version, source, checksum and the pinned SDK', async t => {
  const f = await releaseFixture(t);
  const archive = await packageModule(f.root, f.output);
  const result = await checkRelease(f.root, 'v0.1.0', f.sha, f.output);
  assert.deepEqual(result.sdk, f.pin);
  await assert.rejects(checkRelease(f.root, 'latest', f.sha, f.output));
  await assert.rejects(checkRelease(f.root, 'v0.2.0', f.sha, f.output));
  await assert.rejects(verifyPackage(f.root, archive, 'b'.repeat(40)));
  f.lock.packages[`${f.pin.name}@${f.pin.version}`].resolution.integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
  await writeFile(join(f.root, 'pnpm-lock.yaml'), stringify(f.lock));
  await assert.rejects(verifyPackage(f.root, archive, f.sha), /different SDK package/);
});

test('release refuses corrupted downloads and mismatched release notes', async t => {
  const f = await releaseFixture(t);
  const archive = await packageModule(f.root, f.output);
  const checksum = await readFile(`${archive}.sha256`);
  await writeFile(`${archive}.sha256`, `${'0'.repeat(64)}  cockpit-file-0.1.0.tgz\n`);
  await assert.rejects(checkRelease(f.root, 'v0.1.0', f.sha, f.output));
  await writeFile(`${archive}.sha256`, checksum);
  await writeFile(join(f.root, 'docs/release-notes.md'), '# Cockpit File 9.9.9\n');
  await assert.rejects(checkRelease(f.root, 'v0.1.0', f.sha, f.output));
});

test('lightweight and annotated remote tags must still identify the checked commit', () => {
  const sha = 'a'.repeat(40);
  checkTagTarget('v0.1.0', sha, `${sha}\trefs/tags/v0.1.0`);
  checkTagTarget('v0.1.0', sha, `${'b'.repeat(40)}\trefs/tags/v0.1.0\n${sha}\trefs/tags/v0.1.0^{}`);
  assert.throws(() => checkTagTarget('v0.1.0', sha, `${'b'.repeat(40)}\trefs/tags/v0.1.0`), /moved/);
  assert.throws(() => checkTagTarget('v0.1.0', sha, ''));
});

test('release keeps the verified archive hidden until remote assets pass verification', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const parsed = parse(workflow);
  assert.equal(parsed.jobs.checks.uses, './.github/workflows/build.yml');
  assert.equal(parsed.jobs.publish.needs, 'checks');
  assert.equal(parsed.jobs.publish.permissions.contents, 'write');
  const commands = parsed.jobs.publish.steps.map(step => step.run).filter(Boolean);
  assert.deepEqual(commands.filter(command => /release\.mjs/.test(command)), [
    'node scripts/rolling-release.mjs publish release-artifact',
  ]);
  assert.equal(parsed.jobs.publish.steps.at(-1).env.GH_TOKEN, '${{ github.token }}');
  assert.doesNotMatch(workflow, /--clobber|pnpm (?:build|package)|secrets\.|releases\/tags\/|gh release/);
});
