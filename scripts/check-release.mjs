import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackage } from './verify-package.mjs';

export function checkTagTarget(tag, sha, refs) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  const values = new Map();
  for (const line of refs.trim().split('\n').filter(Boolean)) {
    const [target, ref, extra] = line.trim().split(/\s+/);
    assert.match(target, /^[a-f0-9]{40}$/);
    assert.ok(!extra && [ `refs/tags/${tag}`, `refs/tags/${tag}^{}` ].includes(ref) && !values.has(ref));
    values.set(ref, target);
  }
  assert.ok(values.has(`refs/tags/${tag}`), 'Version tag is missing');
  assert.equal(values.get(`refs/tags/${tag}^{}`) ?? values.get(`refs/tags/${tag}`), sha, 'Version tag moved');
}

export async function checkRelease(root, tag, sha, directory) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/, 'Release tags use vMAJOR.MINOR.PATCH');
  const version = tag.slice(1);
  const notes = await readFile(join(root, 'docs/release-notes.md'), 'utf8');
  assert.equal(notes.split(/\r?\n/)[0], `# Cockpit File ${version}`);
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(metadata.version, version, 'Tag and package version differ');
  const name = `cockpit-file-${version}.tgz`;
  assert.deepEqual((await readdir(directory)).sort(), [name, `${name}.sha256`], 'Release contains unexpected assets');
  return verifyPackage(root, join(directory, name), sha);
}

export function checkReleaseSource(root, tag, sha) {
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sha,
    'Checkout differs from the release source');
  execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: root, stdio: 'pipe' });
  const refs = execFileSync('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { cwd: root, encoding: 'utf8', timeout: 30_000 });
  checkTagTarget(tag, sha, refs);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, sha, directory, ...extra] = process.argv.slice(2);
  if (!tag || !sha || !directory || extra.length) throw new Error('Usage: check-release.mjs TAG SOURCE_SHA ARTIFACT_DIRECTORY');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = await checkRelease(root, tag, sha, resolve(directory));
  checkReleaseSource(root, tag, sha);
  console.log(JSON.stringify(result));
}
