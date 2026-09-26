import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelease, checkReleaseSource } from './check-release.mjs';

function checkId(id) {
  assert.ok(Number.isSafeInteger(id) && id > 0, 'Invalid GitHub object ID');
  return id;
}

export const sealMarker = '\n<!-- cockpit-rolling-assets-v1 -->\n';
export function assetSeal(assets, files) {
  return JSON.stringify(assets.map(asset => ({
    id: asset.id, name: asset.name, size: asset.size,
    sha256: createHash('sha256').update(files.find(file => file.name === asset.name).bytes).digest('hex'),
  })).sort((a, b) => a.name.localeCompare(b.name))) + '\n';
}

export function githubApi(repository, run = execFileSync) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const base = `repos/${repository}`;
  const request = (endpoint, args = [], input) => run('gh',
    ['api', '--hostname', 'github.com', endpoint, ...args],
    { input, timeout: 60_000, maxBuffer: 34 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  const json = (endpoint, args, input) => JSON.parse(request(endpoint, args, input).toString('utf8'));
  const list = endpoint => {
    const pages = json(`${endpoint}?per_page=100`, ['--paginate', '--slurp']);
    assert.ok(Array.isArray(pages) && pages.length > 0 && pages.every(Array.isArray), 'Invalid paginated GitHub response');
    return pages.flat();
  };
  const write = (endpoint, method, body) => json(endpoint,
    ['--method', method, '--input', '-'], JSON.stringify(body));
  return {
    listReleases: () => list(`${base}/releases`),
    resolveTarget: target => json(`${base}/commits/${encodeURIComponent(target)}`).sha,
    listAssets: id => list(`${base}/releases/${checkId(id)}/assets`),
    download: id => request(`${base}/releases/assets/${checkId(id)}`, ['--header', 'Accept: application/octet-stream']),
    create: body => write(`${base}/releases`, 'POST', body),
    upload: (id, file) => json(
      `https://uploads.github.com/${base}/releases/${checkId(id)}/assets?name=${encodeURIComponent(file.name)}`,
      ['--method', 'POST', '--header', 'Content-Type: application/octet-stream',
        '--header', `Content-Length: ${file.bytes.length}`, '--input', '-'], file.bytes),
    publish: id => write(`${base}/releases/${checkId(id)}`, 'PATCH',
      { draft: false, prerelease: false, make_latest: 'true' }),
  };
}

async function writeOnce(label, action) {
  try {
    return await action();
  } catch (cause) {
    throw new Error(`${label} failed; remote write outcome is unknown. Inspect releases and assets before any rerun; no write was retried.`, { cause });
  }
}

export async function publishRelease({ tag, sha, files, notes, api, verifySource }) {
  const rolling = /^v0\.0\.0-rolling\.[1-9]\d*$/.test(tag);
  assert.match(tag, /^v\d+\.\d+\.\d+(?:-rolling\.[1-9]\d*)?$/);
  assert.match(sha, /^[a-f0-9]{40}$/);
  const archive = `cockpit-file-${tag.slice(1)}.tgz`;
  assert.deepEqual(files.map(file => file.name).sort(), [
    ...(rolling ? ['cockpit-deployment.json', 'cockpit-deployment.json.sha256'] : []), archive, `${archive}.sha256`,
  ].sort());
  assert.ok(files.every(file => Buffer.isBuffer(file.bytes) && file.bytes.length > 0));
  assert.equal(notes.split(/\r?\n/)[0], `# Cockpit File ${tag.slice(1)}`);

  const inspect = async expectedId => {
    const releases = await api.listReleases();
    assert.ok(Array.isArray(releases) && releases.every(release => release && typeof release.tag_name === 'string'),
      'Invalid release discovery response');
    const matches = releases.filter(release => release.tag_name === tag);
    assert.ok(matches.length <= 1, `Multiple releases match ${tag}; refusing ambiguous recovery`);
    if (matches.length === 0) {
      assert.equal(expectedId, undefined, 'Release disappeared after a write; inspect the remote state');
      return null;
    }
    const release = matches[0];
    checkId(release.id);
    if (expectedId !== undefined) assert.equal(release.id, expectedId, 'Release identity changed');
    assert.equal(typeof release.draft, 'boolean', 'Invalid release state');
    if (!rolling || release.draft) assert.equal(release.prerelease, rolling, 'Release channel conflicts');
    if (rolling) {
      assert.equal(release.name, `Cockpit File ${tag}`, 'Release title changed');
      if (release.draft) assert.equal(release.body, notes, 'Release notes changed');
    }
    assert.ok(typeof release.target_commitish === 'string' && release.target_commitish.length > 0,
      'Release source is missing');
    const target = release.target_commitish;
    assert.equal(/^[a-f0-9]{40}$/.test(target) ? target : await api.resolveTarget(target), sha,
      'Release target differs from the checked source');
    const assets = await api.listAssets(release.id);
    assert.ok(Array.isArray(assets), 'Invalid asset discovery response');
    const seen = new Set();
    const ids = new Set();
    for (const asset of assets) {
      checkId(asset.id);
      assert.ok(!seen.has(asset.name) && !ids.has(asset.id), 'Duplicate release asset');
      seen.add(asset.name);
      ids.add(asset.id);
      const file = files.find(file => file.name === asset.name);
      assert.ok(file, `Unexpected release asset: ${asset.name}`);
      assert.equal(asset.state, 'uploaded', 'Release asset is incomplete');
      assert.equal(asset.size, file.bytes.length, 'Release asset size differs');
      const bytes = await api.download(asset.id);
      assert.ok(Buffer.isBuffer(bytes) && bytes.equals(file.bytes), `Release asset bytes differ: ${file.name}`);
    }
    const missing = files.filter(file => !seen.has(file.name));
    if (!release.draft) assert.equal(missing.length, 0, 'Published release is incomplete; refusing changes');
    if (rolling && !release.draft) {
      assert.equal(release.body, notes + sealMarker + assetSeal(assets, files), 'Published asset identity or notes changed');
    }
    return { release, missing, assets };
  };

  await verifySource();
  let state = await inspect();
  if (!state) {
    await verifySource();
    // Repeat discovery after the tag check; never interpret lookup failures as absence.
    state = await inspect();
    if (!state) {
      const created = await writeOnce('Draft creation', () => api.create({
        tag_name: tag, target_commitish: sha, draft: true, prerelease: rolling,
        name: `Cockpit File ${tag}`, body: notes, generate_release_notes: !rolling,
        ...(rolling ? { make_latest: 'false' } : {}),
      }));
      assert.ok(created && Number.isSafeInteger(created.id) && created.id > 0,
        'Draft creation returned an unknown identity; inspect remote state before any rerun');
      state = await inspect(created.id);
    }
  }
  const id = state.release.id;
  for (const file of files) {
    await verifySource();
    state = await inspect(id);
    if (!state.release.draft) return { status: 'already_published', id };
    if (state.missing.some(missing => missing.name === file.name)) {
      await writeOnce(`Upload of ${file.name}`, () => api.upload(id, file));
      state = await inspect(id);
      assert.ok(!state.missing.some(missing => missing.name === file.name),
        'Upload is not visible; inspect remote state before any rerun');
    }
  }
  await verifySource();
  state = await inspect(id);
  if (!state.release.draft) return { status: 'already_published', id };
  assert.equal(state.missing.length, 0, 'Draft is incomplete');
  await writeOnce('Draft publication', () => api.publish(id,
    rolling ? notes + sealMarker + assetSeal(state.assets, files) : undefined));
  state = await inspect(id);
  assert.equal(state.release.draft, false, 'Publication is not confirmed; inspect remote state before any rerun');
  await verifySource();
  return { status: 'published', id };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, sha, directory, ...extra] = process.argv.slice(2);
  if (!tag || !sha || !directory || extra.length) throw new Error('Usage: publish-release.mjs TAG SOURCE_SHA ARTIFACT_DIRECTORY');
  const root = fileURLToPath(new URL('..', import.meta.url));
  await checkRelease(root, tag, sha, resolve(directory));
  const archive = `cockpit-file-${tag.slice(1)}.tgz`;
  const files = [];
  for (const name of [archive, `${archive}.sha256`]) {
    files.push({ name, bytes: await readFile(join(resolve(directory), name)) });
  }
  console.log(JSON.stringify(await publishRelease({
    tag, sha, files, notes: await readFile(join(root, 'docs/release-notes.md'), 'utf8'),
    api: githubApi(process.env.GITHUB_REPOSITORY),
    verifySource: () => checkReleaseSource(root, tag, sha),
  })));
}
