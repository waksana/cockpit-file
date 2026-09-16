import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { prepareSdk } from './sdk.mjs';
import { git, sdkIdentity } from './build-identity.mjs';
import { commitFixture, releaseFixture } from './test-support/release-fixture.mjs';

test('SDK preparation checks the exact clean host SHA and produces a verified local snapshot', async t => {
  const f = await releaseFixture(t);
  const host = await mkdtemp(new URL('../node_modules/sdk-host-fixture-', import.meta.url));
  t.after(() => rm(host, { recursive: true, force: true }));
  for (const name of ['module-api', 'protocol']) {
    await mkdir(join(host, 'packages', name), { recursive: true });
    await writeFile(join(host, 'packages', name, 'package.json'), '{"version":"0.2.0"}');
  }
  await mkdir(join(host, 'scripts'));
  await writeFile(join(host, 'scripts/export-module-api.mjs'), `
import {mkdir,writeFile} from 'node:fs/promises';
const target=process.argv[2];
await mkdir(target);
for(const name of ['module-api','protocol']){
  await mkdir(target+'/'+name);
  await writeFile(target+'/'+name+'/package.json',JSON.stringify({name:'@cockpit/'+name,version:'0.2.0'}));
}
await writeFile(target+'/LICENSE','Synthetic SDK license');
`);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: host, stdio: 'pipe' });
  commitFixture(host);
  const pin = { ...f.pin, commit: git(host, ['rev-parse', 'HEAD']) };
  await writeFile(join(f.root, 'tooling/host-sdk.json'), JSON.stringify(pin));
  assert.deepEqual(await prepareSdk(f.root, host), pin);
  assert.deepEqual(await sdkIdentity(f.root), pin);
  assert.deepEqual(await prepareSdk(f.root, host), pin, 'An identical existing SDK is reusable');
  await writeFile(join(host, 'dirty.txt'), 'Uncommitted host change');
  await assert.rejects(prepareSdk(f.root, host), /clean, exact pinned/);
  await rm(join(host, 'dirty.txt'));
  await writeFile(join(f.root, '.cockpit-sdk/protocol/package.json'), '{"version":"different"}');
  await assert.rejects(prepareSdk(f.root, host), /Existing generated SDK differs/);
});

test('CI and release share the exact checked module artifact without deployment privileges', async () => {
  const ci = await readFile(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(ci, /pull_request:/);
  assert.match(ci, /workflow_call:/);
  assert.match(ci, /name: Required checks/);
  assert.match(ci, /sdk\.mjs prepare \.host-sdk-source/);
  assert.match(ci, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(ci, /verify-package\.mjs/);
  assert.match(ci, /module-file\.integration\.test\.ts/);
  assert.match(ci, /retention-days: 7/);
  assert.doesNotMatch(ci, /contents: write|pull_request_target|secrets\./);
  assert.match(release, /uses: \.\/\.github\/workflows\/build\.yml/);
  assert.match(release, /needs: checks/);
  assert.match(release, /check-release\.mjs/);
  assert.match(release, /gh release create/);
  assert.doesNotMatch(release, /pnpm (?:build|package)|--clobber|ssh |systemctl/);
  for (const workflow of [ci, release]) {
    for (const [, use] of workflow.matchAll(/uses:\s+([^\s]+)/g)) {
      if (!use.startsWith('./')) assert.match(use, /^[\w/-]+@[a-f0-9]{40}$/);
    }
  }
});
