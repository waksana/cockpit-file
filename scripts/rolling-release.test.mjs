import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parse } from 'yaml';
import { rollingIdentity, buildIdentity } from './rolling-identity.mjs';
import { assetNames, mergedIdentity, releaseNotes, ensureTag, promoteRolling, verifyRemoteAssets, writeHttps } from './rolling-release.mjs';
import { publishRelease } from './publish-release.mjs';
import { releaseFixture, commitFixture } from './test-support/release-fixture.mjs';
import { packageModule } from './package.mjs';
import { verifyPackage } from './verify-package.mjs';

const sourceSha = 'a'.repeat(40);
const event = (sha = sourceSha) => ({
  action: 'closed', number: 67, repository: { full_name: 'waksana/cockpit-file' },
  pull_request: { merged: true, merge_commit_sha: sha, title: 'Full title', body: 'First line\n\nFull body\n<details>kept</details>',
    base: { ref: 'main', repo: { full_name: 'waksana/cockpit-file' } } },
});

test('every merge category has independent sequence identity, reruns reuse it, late completion cannot redefine order', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on, { pull_request_target: { branches: ['main'], types: ['closed'] } });
  assert.equal(workflow.concurrency, undefined);
  assert.equal(workflow.jobs.checks.if, 'github.event.pull_request.merged == true');
  assert.equal(workflow.jobs.checks.with.source_sha, '${{ github.event.pull_request.merge_commit_sha }}');
  assert.match(workflow.jobs.checks.with.sequence, /github.run_number/);
  const identities = ['feat', 'fix', 'docs', 'chore'].map((title, index) => mergedIdentity({
    ...event(), pull_request: { ...event().pull_request, title },
  }, 11 + index));
  assert.deepEqual(identities.map(value => value.sequence), [11, 12, 13, 14]);
  assert.equal(new Set(identities.map(value => value.tag)).size, 4);
  assert.deepEqual(mergedIdentity(event(), 11), identities[0]);
  assert.equal(Math.max(...[identities[3], identities[0]].map(value => value.sequence)), 14);
  assert.throws(() => mergedIdentity({ ...event(), pull_request: { ...event().pull_request, merged: false } }, 15));
  for (const sequence of [0, -1, '01', '2x', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => rollingIdentity(sequence, sourceSha));
});

test('tag mutation is one attempt, never replaces a conflicting tag, and failure does not block another sequence', async () => {
  const tags = new Map();
  const writes = [];
  const api = {
    tagSha: tag => tags.get(tag) ?? null,
    createTag: (tag, sha) => {
      writes.push(tag);
      if (tag.endsWith('.1')) throw new Error('unknown write result');
      tags.set(tag, sha);
    },
  };
  await assert.rejects(ensureTag(api, rollingIdentity(1, sourceSha)), /unknown/);
  await ensureTag(api, rollingIdentity(2, sourceSha));
  await ensureTag(api, rollingIdentity(2, sourceSha));
  assert.equal(writes.length, 2);
  await assert.rejects(ensureTag(api, rollingIdentity(2, 'b'.repeat(40))), /never replace/);
  assert.equal(writes.length, 2);
});

test('direct HTTPS mutations send fixed bytes once and never retry redirect, failure or malformed response', async () => {
  for (const status of [201, 302, 503]) {
    let calls = 0;
    const payload = Buffer.from([0, 255, 1]);
    const operation = writeHttps('https://uploads.github.com/repos/waksana/cockpit-file/releases/42/assets?name=a',
      'POST', payload, 'synthetic-token', (url, options, onResponse) => {
        calls++;
        assert.equal(options.headers['Content-Length'], 3);
        const req = new EventEmitter();
        req.setTimeout = () => {};
        req.end = bytes => {
          assert.ok(bytes.equals(payload));
          const response = new EventEmitter();
          response.statusCode = status;
          onResponse(response);
          response.emit('data', Buffer.from('{"id":42}'));
          response.emit('end');
        };
        return req;
      });
    if (status === 201) assert.deepEqual(await operation, { id: 42 });
    else await assert.rejects(operation, /unknown.*no automatic retry/);
    assert.equal(calls, 1);
  }
});

test('isolated archive has four assets, byte-identical descriptor, source-derived contracts and dev main', async t => {
  const f = await releaseFixture(t);
  const metadata = JSON.parse(await readFile(join(f.root, 'package.json')));
  metadata.version = '0.0.0-dev';
  await writeFile(join(f.root, 'package.json'), JSON.stringify(metadata));
  const manifest = JSON.parse(await readFile(join(f.root, 'cockpit.module.json')));
  manifest.version = metadata.version;
  await writeFile(join(f.root, 'cockpit.module.json'), JSON.stringify(manifest));
  await writeFile(join(f.root, '.gitignore'), 'dist/\nnode_modules/\n.module-build.json\noutput/\nremote/\n');
  for (const path of ['src/web/index.tsx', 'src/web/file-draft.ts', 'src/server/storage.ts']) {
    await mkdir(join(f.root, path, '..'), { recursive: true });
    await writeFile(join(f.root, path), await readFile(new URL(`../${path}`, import.meta.url)));
  }
  commitFixture(f.root);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim();
  assert.equal((await buildIdentity(f.root, {})).displayVersion, `dev+${sha.slice(0, 7)}`);
  process.env.ROLLING_SEQUENCE = '23';
  process.env.ROLLING_SOURCE_SHA = sha;
  t.after(() => { delete process.env.ROLLING_SEQUENCE; delete process.env.ROLLING_SOURCE_SHA; });
  await f.receipt();
  const archive = await packageModule(f.root, f.output);
  await verifyPackage(f.root, archive, sha);
  const identity = rollingIdentity(23, sha);
  assert.deepEqual((await readdir(f.output)).sort(), assetNames(identity.version));
  const files = await Promise.all(assetNames(identity.version).map(async name => ({ name, bytes: await readFile(join(f.output, name)) })));
  await verifyRemoteAssets(files, identity, join(f.root, 'remote'));
  const descriptor = JSON.parse(files.find(file => file.name === 'cockpit-deployment.json').bytes);
  assert.deepEqual(descriptor.product.hostApi, { min: 1, max: 1 });
  assert.deepEqual(descriptor.product.databases, []);
  assert.deepEqual(descriptor.product.migrations, []);
  assert.ok(descriptor.product.requiresCapabilities.includes('draftSubmission.v1'));
  assert.equal(JSON.parse(await readFile(join(f.root, 'package.json'))).version, '0.0.0-dev');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: f.root, encoding: 'utf8' }), '');
  const notes = releaseNotes(event(sha), identity, files);
  assert.ok(notes.includes(event().pull_request.title) && notes.includes(event().pull_request.body));

  const releases = [];
  const assets = [];
  const writes = [];
  const api = {
    tagSha: () => sha,
    listReleases: () => structuredClone(releases),
    getRelease: id => structuredClone(releases.find(release => release.id === id)),
    listAssets: () => structuredClone(assets),
    download: id => files.find(file => file.name === assets.find(asset => asset.id === id).name).bytes,
    create: body => { writes.push(body); releases.push({ ...body, id: 42 }); return { id: 42 }; },
    upload: (id, file) => { writes.push(file.name); assets.push({ id: assets.length + 1, name: file.name, state: 'uploaded', size: file.bytes.length }); },
    publish: (id, body) => { writes.push('publish'); releases[0].draft = false; releases[0].body = body; },
    promote: () => { writes.push('promote'); releases[0].prerelease = false; },
    latest: () => releases[0],
  };
  const options = { tag: identity.tag, sha, files, notes, api, verifySource: () => {} };
  assert.equal((await publishRelease(options)).status, 'published');
  assert.equal(releases[0].prerelease, true);
  assert.equal(releases[0].make_latest, 'false');
  assert.equal(writes.length, 6);
  assert.equal((await publishRelease(options)).status, 'already_published');
  assert.equal(writes.length, 6);
  const verify = (remote, current) => verifyRemoteAssets(remote, current, join(f.root, 'remote'));
  await assert.rejects(promoteRolling('v0.2.6', 'v0.2.6', api, verify));
  await assert.rejects(promoteRolling(identity.tag, 'no', api, verify));
  const removed = assets.pop();
  await assert.rejects(promoteRolling(identity.tag, identity.tag, api, verify));
  assets.push(removed);
  const original = api.download;
  api.download = id => Buffer.concat([original(id), Buffer.from('changed')]);
  await assert.rejects(promoteRolling(identity.tag, identity.tag, api, verify));
  api.download = original;
  const archiveFile = files.find(file => file.name.endsWith('.tgz'));
  const checksumFile = files.find(file => file.name === `${archiveFile.name}.sha256`);
  const originalArchive = archiveFile.bytes;
  const originalChecksum = checksumFile.bytes;
  archiveFile.bytes = Buffer.from(archiveFile.bytes);
  archiveFile.bytes[4] ^= 1;
  checksumFile.bytes = Buffer.from(`${createHash('sha256').update(archiveFile.bytes).digest('hex')}  ${archiveFile.name}\n`);
  await assert.rejects(promoteRolling(identity.tag, identity.tag, api, verify), /original Rolling publication/);
  archiveFile.bytes = originalArchive;
  checksumFile.bytes = originalChecksum;
  const initial = structuredClone({ assets, notes: releases[0].body, title: releases[0].name });
  await promoteRolling(identity.tag, identity.tag, api, verify);
  assert.deepEqual({ assets, notes: releases[0].body, title: releases[0].name }, initial);
  assert.equal(releases[0].prerelease, false);
  assert.equal(writes.length, 7);
  api.latest = () => ({ id: 99 });
  const promote = api.promote;
  api.promote = () => { promote(); api.latest = () => releases[0]; };
  await promoteRolling(identity.tag, identity.tag, api, verify);
  assert.equal(writes.length, 8, 'An explicitly reselected old Milestone can become Latest again');
  assert.equal((await publishRelease(options)).status, 'already_published');
  assert.equal(releases[0].prerelease, false);
  assert.equal(writes.length, 8);

  let reads = 0;
  api.listAssets = () => {
    if (++reads === 2) assets[0].id += 10;
    return structuredClone(assets);
  };
  await assert.rejects(promoteRolling(identity.tag, identity.tag, api, verify), /original Rolling publication/);
  assert.equal(writes.length, 8);
});
