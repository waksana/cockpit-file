import assert from 'node:assert/strict';
import { request } from 'node:https';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubApi, publishRelease, assetSeal, sealMarker } from './publish-release.mjs';
import { verifyPackage } from './verify-package.mjs';
import { repository, rollingIdentity } from './rolling-identity.mjs';

// Mutations must not use gh/fetch retry middleware or follow redirects.
export function writeHttps(url, method, value, token = process.env.GH_TOKEN, requestImpl = request) {
  assert.ok(token, 'GitHub token is required');
  const target = new URL(url);
  assert.ok(target.protocol === 'https:' && ['api.github.com', 'uploads.github.com'].includes(target.hostname)
    && !target.username && !target.password && !target.port);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const fail = cause => reject(new Error('Remote write outcome unknown; inspect state; no automatic retry', { cause }));
    const req = requestImpl(target, {
      method, headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'cockpit-file-rolling',
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': Buffer.isBuffer(value) ? 'application/octet-stream' : 'application/json',
        'Content-Length': bytes.length },
    }, response => {
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 1024 * 1024) response.destroy(new Error('Response too large'));
        else chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return fail(new Error(`HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { fail(error); }
      });
    });
    req.setTimeout(60_000, () => req.destroy(new Error('Write timed out')));
    req.on('error', fail);
    req.end(bytes);
  });
}

export function rollingApi() {
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  const api = githubApi(repository);
  const base = `https://api.github.com/repos/${repository}`;
  const id = value => { assert.ok(Number.isSafeInteger(value) && value > 0); return value; };
  return {
    ...api,
    createTag: (tag, sha) => writeHttps(`${base}/git/refs`, 'POST', { ref: `refs/tags/${tag}`, sha }),
    create: body => writeHttps(`${base}/releases`, 'POST', body),
    upload: (release, file) => writeHttps(
      `https://uploads.github.com/repos/${repository}/releases/${id(release)}/assets?name=${encodeURIComponent(file.name)}`,
      'POST', file.bytes),
    publish: (release, body) => writeHttps(`${base}/releases/${id(release)}`, 'PATCH',
      { draft: false, prerelease: true, make_latest: 'false', body }),
    promote: release => writeHttps(`${base}/releases/${id(release)}`, 'PATCH', { prerelease: false, make_latest: 'true' }),
    latest: () => JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/latest`], { encoding: 'utf8' })),
    tagSha: tag => {
      const refs = execFileSync('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
        { encoding: 'utf8', timeout: 60_000 }).trim();
      if (!refs) return null;
      const rows = refs.split('\n').map(row => row.split(/\s+/));
      return (rows.find(row => row[1].endsWith('^{}')) ?? rows[0])[0];
    },
  };
}

export function mergedIdentity(event, sequence) {
  assert.equal(event.repository.full_name, repository);
  assert.equal(event.action, 'closed');
  assert.equal(event.pull_request.merged, true);
  assert.equal(event.pull_request.base.ref, 'main');
  assert.equal(event.pull_request.base.repo.full_name, repository);
  assert.ok(Number.isSafeInteger(event.number) && event.number > 0);
  assert.equal(typeof event.pull_request.title, 'string');
  assert.ok(event.pull_request.body === null || typeof event.pull_request.body === 'string');
  return rollingIdentity(sequence, event.pull_request.merge_commit_sha);
}

export function releaseNotes(event, identity, files) {
  return `# Cockpit File ${identity.version}\n\n## PR #${event.number}: ${event.pull_request.title}\n\n`
    + `${event.pull_request.body ?? ''}\n\n---\nRepository: ${repository}\nSource: ${identity.sourceSha}\n`
    + `Tag: ${identity.tag}\nSequence: ${identity.sequence}\n\n`
    + files.map(file => `- ${file.name}: sha256:${createHash('sha256').update(file.bytes).digest('hex')}`).join('\n') + '\n';
}

export async function ensureTag(api, identity) {
  let sha = await api.tagSha(identity.tag);
  if (sha === null) {
    await api.createTag(identity.tag, identity.sourceSha);
    sha = await api.tagSha(identity.tag);
  }
  assert.equal(sha, identity.sourceSha, 'Tag is missing or moved; never replace it');
}

export function assetNames(version) {
  const archive = `cockpit-file-${version}.tgz`;
  return ['cockpit-deployment.json', 'cockpit-deployment.json.sha256', archive, `${archive}.sha256`].sort();
}

export async function publishRolling(root, event, sequence, directory, api) {
  const identity = mergedIdentity(event, sequence);
  assert.equal(process.env.ROLLING_SOURCE_SHA, identity.sourceSha);
  assert.equal(process.env.ROLLING_SEQUENCE, String(identity.sequence));
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), identity.sourceSha);
  assert.deepEqual((await readdir(directory)).sort(), assetNames(identity.version));
  await verifyPackage(root, join(directory, `cockpit-file-${identity.version}.tgz`), identity.sourceSha);
  const files = await Promise.all(assetNames(identity.version).map(async name => ({ name, bytes: await readFile(join(directory, name)) })));
  await ensureTag(api, identity);
  return publishRelease({ tag: identity.tag, sha: identity.sourceSha, files,
    notes: releaseNotes(event, identity, files), api,
    verifySource: async () => assert.equal(await api.tagSha(identity.tag), identity.sourceSha, 'Tag changed') });
}

export async function verifyRemoteAssets(files, identity, directory) {
  assert.deepEqual(files.map(file => file.name).sort(), assetNames(identity.version));
  for (const name of [`cockpit-file-${identity.version}.tgz`, 'cockpit-deployment.json']) {
    const bytes = files.find(file => file.name === name).bytes;
    assert.equal(files.find(file => file.name === `${name}.sha256`).bytes.toString(),
      `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
  }
  const bytes = files.find(file => file.name === 'cockpit-deployment.json').bytes;
  const descriptor = JSON.parse(bytes);
  for (const [key, value] of Object.entries(identity)) assert.deepEqual(descriptor[key], value);
  assert.equal(descriptor.format, 2);
  assert.equal(descriptor.channel, 'rolling');
  assert.equal(descriptor.product.kind, 'module');
  assert.equal(descriptor.product.id, 'cockpit-file');
  assert.deepEqual(Object.keys(descriptor).sort(), [
    'archive', 'channel', 'format', 'product', 'repository', 'sequence', 'sourceSha', 'tag', 'version',
  ]);
  const product = descriptor.product;
  assert.deepEqual(Object.keys(product).sort(), [
    'databases', 'hostApi', 'id', 'kind', 'migrations', 'requiredIntents', 'requiresCapabilities',
  ]);
  assert.deepEqual(Object.keys(product.hostApi).sort(), ['max', 'min']);
  assert.ok(Number.isSafeInteger(product.hostApi.min) && product.hostApi.min > 0
    && Number.isSafeInteger(product.hostApi.max) && product.hostApi.max >= product.hostApi.min);
  for (const [key, pattern, maximum] of [
    ['requiresCapabilities', /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/, 256],
    ['requiredIntents', /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/, 128],
  ]) {
    assert.ok(Array.isArray(product[key]) && product[key].length <= maximum);
    assert.equal(new Set(product[key]).size, product[key].length);
    for (const value of product[key]) assert.ok(typeof value === 'string' && pattern.test(value));
  }
  assert.ok(product.requiresCapabilities.includes('module-api.v1'));
  // This module has no database or migration machinery. New storage contracts require explicit support.
  assert.deepEqual(product.databases, []);
  assert.deepEqual(product.migrations, []);
  assert.deepEqual(descriptor.archive, { name: `cockpit-file-${identity.version}.tgz` });
  await mkdir(directory, { recursive: true });
  const archive = join(directory, descriptor.archive.name);
  await writeFile(archive, files.find(file => file.name === descriptor.archive.name).bytes, { flag: 'wx' });
  try {
    const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
      .trim().split('\n');
    assert.equal(new Set(names).size, names.length, 'Duplicate archive paths');
    for (const name of names) assert.ok(!/[\\\x00-\x1f]/.test(name)
      && name.replace(/\/$/, '').split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe archive path');
    const entries = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim().split('\n');
    assert.ok(entries.every(entry => entry.startsWith('-') || entry.startsWith('d')), 'Links or special archive entries');
    const read = name => execFileSync('tar', ['-xOzf', archive, name], { maxBuffer: 32 * 1024 * 1024 });
    assert.ok(read('cockpit-deployment.json').equals(bytes), 'Embedded descriptor differs');
    const manifest = JSON.parse(read('cockpit.module.json'));
    assert.equal(manifest.version, identity.version);
    assert.equal(manifest.id, 'cockpit-file');
    assert.ok(manifest.apiVersion >= product.hostApi.min && manifest.apiVersion <= product.hostApi.max);
    const build = JSON.parse(read('module-build.json'));
    assert.equal(build.format, 1);
    assert.equal(build.product, 'cockpit-file');
    assert.equal(build.sourceSha, identity.sourceSha);
    assert.equal(build.version, identity.version);
    assert.ok(Array.isArray(build.files) && build.files.length > 0, 'Missing file inventory');
    const expected = new Set(['module-build.json']);
    for (const file of build.files) {
      assert.ok(typeof file.path === 'string' && (['cockpit.module.json', 'LICENSE', 'cockpit-deployment.json'].includes(file.path)
        || file.path.startsWith('dist/')) && !expected.has(file.path), 'Invalid inventory entry');
      assert.ok(!/[\\\x00-\x1f]/.test(file.path)
        && file.path.split('/').every(part => part && part !== '.' && part !== '..'));
      expected.add(file.path);
      const content = read(file.path);
      assert.equal(content.length, file.bytes);
      assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256);
    }
    for (const path of ['cockpit.module.json', 'cockpit-deployment.json', 'LICENSE', manifest.backend,
      ...(manifest.instructions ? [manifest.instructions] : []), manifest.frontend?.entry, ...(manifest.frontend?.styles ?? [])]) {
      assert.ok(expected.has(path), `Missing required package entry: ${path}`);
    }
    assert.deepEqual(names.filter(name => !name.endsWith('/')).sort(), [...expected].sort());
  } finally { await rm(archive); }
}

export async function promoteRolling(tag, confirmation, api, verify) {
  assert.equal(confirmation, tag, 'Confirmation must exactly repeat the selected tag');
  assert.match(tag, /^v0\.0\.0-rolling\.[1-9]\d*$/);
  const snapshot = async () => {
    const matches = (await api.listReleases()).filter(release => release.tag_name === tag);
    assert.equal(matches.length, 1, 'Expected one existing Rolling release');
    const release = matches[0];
    assert.equal(release.draft, false);
    const sourceSha = await api.tagSha(tag);
    const identity = rollingIdentity(tag.split('.').at(-1), sourceSha);
    assert.equal(release.target_commitish, sourceSha);
    const assets = await api.listAssets(release.id);
    assert.deepEqual(assets.map(asset => asset.name).sort(), assetNames(identity.version));
    assert.equal(new Set(assets.map(asset => asset.id)).size, 4);
    const files = await Promise.all(assets.map(async asset => {
      assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0);
      assert.equal(asset.state, 'uploaded');
      const bytes = await api.download(asset.id);
      assert.equal(bytes.length, asset.size);
      return { name: asset.name, bytes };
    }));
    assert.equal(typeof release.body, 'string');
    const sealOffset = release.body.lastIndexOf(sealMarker);
    assert.ok(sealOffset >= 0, 'Missing original Rolling publication asset identities');
    assert.equal(release.body.slice(sealOffset + sealMarker.length), assetSeal(assets, files),
      'Assets differ from original Rolling publication');
    await verify(files, identity);
    return { release, identity, assets: assets.map(asset => ({
      id: asset.id, name: asset.name, size: asset.size, digest: asset.digest,
      created_at: asset.created_at, updated_at: asset.updated_at,
    })).sort((a, b) => a.name.localeCompare(b.name)), hashes: files.map(file => ({
      name: file.name, sha256: createHash('sha256').update(file.bytes).digest('hex'),
    })).sort((a, b) => a.name.localeCompare(b.name)) };
  };
  const before = await snapshot();
  const invariant = value => ({ id: value.release.id, name: value.release.name, body: value.release.body,
    tag: value.release.tag_name, target: value.release.target_commitish,
    identity: value.identity, assets: value.assets, hashes: value.hashes });
  assert.deepEqual(invariant(await snapshot()), invariant(before), 'Release changed before promotion');
  if (before.release.prerelease || (await api.latest()).id !== before.release.id) await api.promote(before.release.id);
  const after = await snapshot();
  assert.deepEqual(invariant(after), invariant(before), 'Release identity changed during promotion');
  assert.equal(after.release.prerelease, false);
  assert.equal((await api.latest()).id, before.release.id, 'Latest promotion not confirmed');
  return { status: 'promoted', id: before.release.id, tag };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const api = rollingApi();
  if (command === 'publish') {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    console.log(await publishRolling(root, event, process.env.GITHUB_RUN_NUMBER, resolve(args[0]), api));
  } else if (command === 'promote') {
    console.log(await promoteRolling(args[0], args[1], api,
      (files, identity) => verifyRemoteAssets(files, identity, join(root, '.fixtures', `promotion-${process.env.GITHUB_RUN_ID}`))));
  } else throw new Error('Expected publish DIRECTORY or promote TAG CONFIRMATION');
}
