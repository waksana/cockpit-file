import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import { lockedSdkIdentity, sdkIdentity } from './build-identity.mjs';
import { hostIntegration } from './host-integration.mjs';
import { releaseFixture } from './test-support/release-fixture.mjs';

test('SDK identity comes from the exact registry lock and installed package, without host source', async t => {
  const f = await releaseFixture(t);
  await rm(join(f.root, 'tooling/host-integration.json'));
  assert.deepEqual(await lockedSdkIdentity(f.root), f.pin);
  assert.deepEqual(await sdkIdentity(f.root), f.pin);
  await writeFile(join(f.root, 'node_modules', f.pin.name, 'package.json'), JSON.stringify({ name: f.pin.name, version: '0.1.1' }));
  await assert.rejects(sdkIdentity(f.root), /Installed SDK differs/);
});

test('SDK identity rejects ranges, stale locks, local inputs and credential-bearing sources', async t => {
  const f = await releaseFixture(t);
  const file = join(f.root, 'pnpm-lock.yaml');
  const dependency = f.lock.importers['.'].devDependencies[f.pin.name];
  const resolution = f.lock.packages[`${f.pin.name}@${f.pin.version}`].resolution;
  for (const version of ['^0.2.0', 'file:local', '0.1.1']) {
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ devDependencies: { [f.pin.name]: version } }));
    await assert.rejects(lockedSdkIdentity(f.root), /exact registry dependency/);
  }
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ devDependencies: { [f.pin.name]: f.pin.version } }));
  dependency.version = 'file:local';
  await writeFile(file, stringify(f.lock));
  await assert.rejects(lockedSdkIdentity(f.root), /exact registry dependency/);
  dependency.version = '0.2.0(@types/node@25.9.5)';
  for (const tarball of ['file:local.tgz', f.pin.resolved.replace('npm.pkg.github.com', 'example.invalid'),
    f.pin.resolved.replace('https://', 'https://token@'), `${f.pin.resolved}?token=secret`,
    f.pin.resolved.replace('/0.2.0/', '/0.1.1/')]) {
    resolution.tarball = tarball;
    await writeFile(file, stringify(f.lock));
    await assert.rejects(lockedSdkIdentity(f.root), /credential-free GitHub Packages/);
  }
  resolution.tarball = f.pin.resolved;
  resolution.integrity = 'sha512-missing';
  await writeFile(file, stringify(f.lock));
  await assert.rejects(lockedSdkIdentity(f.root), /locked SHA-512 integrity/);
  resolution.integrity = f.pin.integrity;
  await writeFile(file, stringify(f.lock));
  assert.deepEqual(await lockedSdkIdentity(f.root), f.pin);
});

test('host compatibility is a separate immutable integration input', async t => {
  const f = await releaseFixture(t);
  const expected = { repository: 'waksana/cockpit', commit: 'a'.repeat(40), archive: 'cockpit-file-0.1.0.tgz' };
  assert.deepEqual(await hostIntegration(f.root), expected);
  await writeFile(join(f.root, 'tooling/host-integration.json'), JSON.stringify({ repository: expected.repository, commit: 'main' }));
  await assert.rejects(hostIntegration(f.root), /Invalid pinned integration host/);
});

test('all four published SDK entries load as ESM and do not require a host checkout', async () => {
  for (const suffix of ['', '/backend', '/frontend', '/runtime']) {
    const entry = await import(`@waksana/cockpit-module-sdk${suffix}`);
    assert.equal(typeof entry, 'object');
  }
});

test('CI builds from the registry before checking out the isolated integration host', async () => {
  const ci = await readFile(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const workflow = parse(ci);
  const steps = workflow.jobs.build.steps;
  assert.match(ci, /pull_request:/);
  assert.match(ci, /workflow_call:/);
  assert.match(ci, /name: Required checks/);
  assert.doesNotMatch(ci, /sdk\.mjs|\.cockpit-sdk|\.host-sdk-source/);
  assert.match(ci, /verify-package\.mjs/);
  assert.match(ci, /module-file\.integration\.test\.ts/);
  assert.match(ci, /retention-days: 7/);
  assert.doesNotMatch(ci, /contents: write|pull_request_target|secrets\./);
  assert.equal(workflow.permissions.packages, 'read');
  const install = steps.find(step => step.run === 'pnpm install --frozen-lockfile --ignore-scripts');
  assert.equal(install.env.NODE_AUTH_TOKEN, '${{ github.token }}');
  assert.equal(steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['registry-url'], 'https://npm.pkg.github.com');
  assert.ok(steps.findIndex(step => step.run === 'pnpm package')
    < steps.findIndex(step => step.with?.path === '.host-integration'));
  assert.match(release, /uses: \.\/\.github\/workflows\/build\.yml/);
  assert.equal(parse(release).jobs.checks.permissions.packages, 'read');
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
