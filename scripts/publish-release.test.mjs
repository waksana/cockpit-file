import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { githubApi, publishRelease } from './publish-release.mjs';

const tag = 'v0.1.0';
const sha = 'a'.repeat(40);
const files = [
  { name: 'cockpit-file-0.1.0.tgz', bytes: Buffer.from('checked archive') },
  { name: 'cockpit-file-0.1.0.tgz.sha256', bytes: Buffer.from('checked checksum') },
];
const release = () => ({ id: 42, tag_name: tag, target_commitish: sha, draft: true, prerelease: false });
const asset = (index, id = index + 1) => ({
  id, name: files[index].name, state: 'uploaded', size: files[index].bytes.length,
});

function fixture({ releases = [release()], assets = files.map((_, index) => asset(index)) } = {}) {
  const writes = [];
  const downloads = [];
  let sourceChecks = 0;
  const api = {
    listReleases: async () => structuredClone(releases),
    resolveTarget: async () => sha,
    listAssets: async () => structuredClone(assets),
    download: async id => {
      downloads.push(id);
      return files.find(file => file.name === assets.find(asset => asset.id === id).name).bytes;
    },
    create: async body => {
      writes.push(['create', body]);
      releases.push({ ...release(), ...body });
      return { id: 42 };
    },
    upload: async (id, file) => {
      writes.push(['upload', id, file.name]);
      assets.push(asset(files.indexOf(file)));
      return assets.at(-1);
    },
    publish: async id => {
      writes.push(['publish', id]);
      releases.find(release => release.id === id).draft = false;
      return releases.find(release => release.id === id);
    },
  };
  const options = { tag, sha, files, notes: '# Cockpit File 0.1.0\n', api,
    verifySource: async () => { sourceChecks++; } };
  return { api, options, writes, downloads, releases, assets, sourceChecks: () => sourceChecks };
}

test('a unique complete draft is recovered by ID without creation or asset replacement', async () => {
  const f = fixture();
  f.releases.unshift({ ...release(), id: 40, tag_name: `${tag}-rc.1` });
  assert.deepEqual(await publishRelease(f.options), { status: 'published', id: 42 });
  assert.deepEqual(f.writes, [['publish', 42]]);
  assert.ok(f.downloads.includes(1) && f.downloads.includes(2));
  assert.ok(f.sourceChecks() >= 3);
});

test('proven absence creates a SHA-bound draft and uploads only verified files before publication', async () => {
  const f = fixture({ releases: [], assets: [] });
  await publishRelease(f.options);
  assert.deepEqual(f.writes.map(write => write[0]), ['create', 'upload', 'upload', 'publish']);
  assert.deepEqual(f.writes[0][1], { tag_name: tag, target_commitish: sha, draft: true,
    prerelease: false, name: `Cockpit File ${tag}`, body: f.options.notes, generate_release_notes: true });
});

test('partial and empty drafts upload only missing assets, never existing assets', async () => {
  for (const assets of [[], [asset(0)], [asset(1)]]) {
    const missing = files.filter(file => !assets.some(asset => asset.name === file.name)).map(file => file.name);
    const f = fixture({ assets });
    await publishRelease(f.options);
    assert.deepEqual(f.writes.filter(write => write[0] === 'upload').map(write => write[2]), missing);
    assert.equal(f.writes.at(-1)[0], 'publish');
  }
});

test('an already-published identical release is a verified no-op; incomplete publication is a conflict', async () => {
  const f = fixture({ releases: [{ ...release(), draft: false }] });
  assert.deepEqual(await publishRelease(f.options), { status: 'already_published', id: 42 });
  assert.deepEqual(f.writes, []);
  f.assets.pop();
  await assert.rejects(publishRelease(f.options), /Published release is incomplete/);
  assert.deepEqual(f.writes, []);
});

test('legacy target refs must resolve to the exact checked source', async () => {
  const f = fixture({ releases: [{ ...release(), target_commitish: 'main' }] });
  let target;
  f.api.resolveTarget = async value => { target = value; return sha; };
  await publishRelease(f.options);
  assert.equal(target, 'main');
  f.writes.length = 0;
  f.api.resolveTarget = async () => 'b'.repeat(40);
  await assert.rejects(publishRelease(f.options), /target differs/);
  assert.deepEqual(f.writes, []);
});

test('duplicate exact tags and conflicting release identities fail before any write', async () => {
  const cases = [
    [release(), { ...release(), id: 43 }],
    [release(), { ...release(), id: 43, draft: false }],
    [{ ...release(), prerelease: true }],
    [{ ...release(), target_commitish: 'b'.repeat(40) }],
    [{ ...release(), target_commitish: null }],
    [{ ...release(), id: null }],
    [{ ...release(), draft: null }],
  ];
  for (const releases of cases) {
    const f = fixture({ releases });
    await assert.rejects(publishRelease(f.options));
    assert.deepEqual(f.writes, []);
  }
});

test('unexpected, duplicate, starter, wrong-size and corrupt assets fail closed', async () => {
  const cases = [
    [asset(0), asset(1), { ...asset(0, 3), name: 'extra.txt' }],
    [asset(0), asset(0, 3)],
    [asset(0), asset(1, 1)],
    [{ ...asset(0), state: 'starter' }],
    [{ ...asset(0), size: 0 }],
  ];
  for (const assets of cases) {
    const f = fixture({ assets });
    await assert.rejects(publishRelease(f.options));
    assert.deepEqual(f.writes, []);
  }
  for (const id of [1, 2]) {
    const f = fixture();
    const download = f.api.download;
    f.api.download = async assetId => assetId === id ? Buffer.alloc(files[id - 1].bytes.length) : download(assetId);
    await assert.rejects(publishRelease(f.options), /bytes differ/);
    assert.deepEqual(f.writes, []);
  }
});

test('read failures including HTTP 404, authorization, pagination and download errors never mean absence', async () => {
  for (const method of ['listReleases', 'listAssets', 'download']) {
    for (const message of ['HTTP 404', 'HTTP 403', 'pagination failed', 'timeout']) {
      const f = fixture();
      f.api[method] = async () => { throw new Error(message); };
      await assert.rejects(publishRelease(f.options), error => error.message === message);
      assert.deepEqual(f.writes, []);
    }
  }
});

test('unknown create, upload and publish results are never retried even when the mutation applied', async () => {
  for (const method of ['create', 'upload', 'publish']) {
    for (const applied of [false, true]) {
      const f = fixture(method === 'create' ? { releases: [], assets: [] } :
        method === 'upload' ? { assets: [] } : {});
      const original = f.api[method];
      let calls = 0;
      f.api[method] = async (...args) => {
        calls++;
        if (applied) await original(...args);
        throw new Error('connection lost');
      };
      await assert.rejects(publishRelease(f.options), /remote write outcome is unknown/);
      assert.equal(calls, 1);
      assert.ok(!f.writes.some(write => write[0] === 'publish') || method === 'publish');
      f.api[method] = original;
      // A separate, explicitly initiated recovery rediscovers the actual remote state.
      await publishRelease(f.options);
      assert.equal(f.releases[0].draft, false);
    }
  }
});

test('acknowledged writes without confirmed remote readback stop instead of repeating', async () => {
  for (const method of ['create', 'upload', 'publish']) {
    const f = fixture(method === 'create' ? { releases: [], assets: [] } :
      method === 'upload' ? { assets: [] } : {});
    let calls = 0;
    f.api[method] = async () => { calls++; return { id: 42 }; };
    await assert.rejects(publishRelease(f.options), /inspect.*remote|inspect the remote/i);
    assert.equal(calls, 1);
  }
});

test('tag movement, release replacement and new asset conflicts stop the next write', async () => {
  const f = fixture();
  let checks = 0;
  f.options.verifySource = async () => { if (++checks === 2) throw new Error('Version tag moved'); };
  await assert.rejects(publishRelease(f.options), /tag moved/);
  assert.deepEqual(f.writes, []);
  for (const change of [
    releases => { releases[0].id = 99; },
    releases => { releases.push({ ...release(), id: 99 }); },
  ]) {
    const changed = fixture();
    changed.options.verifySource = async () => { if (changed.downloads.length) change(changed.releases); };
    await assert.rejects(publishRelease(changed.options), /identity changed|Multiple releases/);
    assert.deepEqual(changed.writes, []);
  }
  const changed = fixture({ assets: [] });
  const upload = changed.api.upload;
  changed.api.upload = async (...args) => {
    await upload(...args);
    changed.assets.push({ ...asset(1), name: 'unexpected.txt' });
  };
  await assert.rejects(publishRelease(changed.options), /Unexpected release asset/);
  assert.equal(changed.writes.length, 1);
});

test('GitHub adapter paginates discovery and uses release/asset IDs, never the tag release endpoint', async () => {
  const calls = [];
  const api = githubApi('owner/repo', (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('--paginate')) return Buffer.from(JSON.stringify([[{ id: 1 }], [{ id: 2 }]]));
    if (args.includes('Accept: application/octet-stream')) return Buffer.from('asset bytes');
    return Buffer.from('{"id":42,"sha":"source"}');
  });
  assert.deepEqual(await api.listReleases(), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(await api.listAssets(42), [{ id: 1 }, { id: 2 }]);
  assert.equal((await api.download(7)).toString(), 'asset bytes');
  await api.create({ draft: true });
  await api.upload(42, files[0]);
  await api.publish(42);
  assert.equal(await api.resolveTarget('release/source'), 'source');
  assert.ok(calls.every(call => call.command === 'gh' && call.args.includes('--hostname')));
  assert.ok(calls.slice(0, 2).every(call => call.args.includes('--slurp') && call.args.includes('--paginate')));
  assert.ok(calls[0].args.includes('repos/owner/repo/releases?per_page=100'));
  assert.ok(calls[1].args.includes('repos/owner/repo/releases/42/assets?per_page=100'));
  assert.ok(calls[2].args.includes('repos/owner/repo/releases/assets/7'));
  assert.ok(calls[4].args.includes('https://uploads.github.com/repos/owner/repo/releases/42/assets?name=cockpit-file-0.1.0.tgz'));
  assert.equal(calls[4].options.input, files[0].bytes);
  assert.ok(calls[4].args.includes(`Content-Length: ${files[0].bytes.length}`));
  assert.deepEqual(JSON.parse(calls[5].options.input), { draft: false, prerelease: false, make_latest: 'true' });
  assert.ok(calls[6].args.includes('repos/owner/repo/commits/release%2Fsource'));
  assert.ok(calls.every(call => !call.args.some(arg => arg.includes('/releases/tags/'))));
});

test('GitHub adapter does not turn failed or malformed pagination into an empty result', () => {
  for (const output of ['[]', '{}', '[null]', 'not json']) {
    const api = githubApi('owner/repo', () => Buffer.from(output));
    assert.throws(() => api.listReleases());
  }
  const api = githubApi('owner/repo', () => { throw new Error('later page failed'); });
  assert.throws(() => api.listReleases(), /later page failed/);
});

test('actual gh asset upload sends Content-Length and unchanged binary bytes over loopback', async t => {
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  let args;
  githubApi('fixture/repo', (_command, commandArgs) => {
    args = commandArgs;
    return Buffer.from('{}');
  }).upload(42, { name: 'fixture.tgz', bytes });
  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { headers: request.headers, bytes: Buffer.concat(chunks) };
    response.setHeader('Content-Type', 'application/json');
    response.end('{"id":42}');
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  args[3] = `http://127.0.0.1:${server.address().port}/assets`;
  const child = spawn('gh', args, {
    env: { ...process.env, GH_TOKEN: 'synthetic-token', GH_HOST: 'github.com' },
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000,
  });
  let error = '';
  child.stdout.resume();
  child.stderr.on('data', chunk => { error += chunk; });
  child.stdin.end(bytes);
  const [code] = await once(child, 'close');
  assert.equal(code, 0, error);
  assert.equal(received.headers['content-length'], String(bytes.length));
  assert.equal(received.headers['transfer-encoding'], undefined);
  assert.deepEqual(received.bytes, bytes);
});
