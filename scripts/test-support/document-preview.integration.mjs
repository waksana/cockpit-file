import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const source = process.env.COCKPIT_HOST_SOURCE;
if (!source) throw new Error('COCKPIT_HOST_SOURCE must identify the pinned integration host');
const load = path => import(pathToFileURL(resolve(source, path)).href);
const require = createRequire(resolve(source, 'apps/server/package.json'));
const Fastify = require('fastify');
const { moduleFixture } = await load('apps/server/src/test-support/module-fixture.ts');
const { ModuleHost } = await load('apps/server/src/module-host.ts');
const { installLocalModule } = await load('apps/server/src/module-install.ts');
const { harness } = await load('packages/core/test-support/engine-harness.ts');

test('packaged document renderer preserves Host routing and CSP while keeping original downloads', async t => {
  const f = await moduleFixture(t);
  const h = harness(t);
  await installLocalModule(resolve(process.env.COCKPIT_FILE_MODULE_ARCHIVE),
    { hostRoot: f.hostRoot, trustLocalCode: true, enable: true });
  const app = Fastify();
  const host = new ModuleHost({ hostRoot: f.hostRoot, observer: h.engine, host: { call() { assert.fail('Preview must not call native APIs'); } } });
  await host.register(app);
  await app.ready();
  t.after(async () => { await host.close(); await app.close(); });
  assert.deepEqual(host.bootstrap().errors, []);
  const files = host.bootstrap().modules.find(item => item.id === 'cockpit-file');
  for (const [name, original, marker] of [
    ['page.html', '<style>p{color:blue}</style><p>Hello</p><script>parent.secret()</script><img src="/api/private">',
      '<p>Hello</p>'],
    ['notes.md', '# Rendered\n\n| A | B |\n| - | - |\n| 1 | 2 |', '<h1>Rendered</h1>'],
  ]) {
    const upload = await app.inject({ method: 'POST', url: `${files.apiBase}/upload?name=${name}&operationId=${name}`,
      headers: { 'content-type': 'application/octet-stream', 'x-cockpit-module-digest': files.digest }, payload: original });
    assert.equal(upload.statusCode, 200, upload.body);
    const url = upload.json().url;
    const head = await app.inject({ method: 'HEAD', url });
    assert.equal(head.headers['x-file-preview'], name.endsWith('.md') ? 'markdown' : 'html');
    const preview = await app.inject(`${url}?preview=1`);
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(preview.headers['content-disposition'], 'inline');
    assert.equal(preview.headers['x-cockpit-module-digest'], files.digest);
    assert.match(preview.headers['content-security-policy'], /^sandbox allow-popups allow-popups-to-escape-sandbox;/);
    assert.doesNotMatch(preview.headers['content-security-policy'], /allow-same-origin|allow-scripts/);
    assert.ok(preview.body.includes(marker));
    assert.doesNotMatch(preview.body, /<script|src="\/api/);
    const download = await app.inject(`${url}?download=1`);
    assert.match(download.headers['content-disposition'], /^attachment;/);
    assert.equal(download.body, original);
    assert.equal((await app.inject({ url: `${url}?preview=1`, headers: { 'x-cockpit-module-digest': 'stale' } })).statusCode, 409);
  }
  for (const [name, payload, status, code] of [
    ['invalid.md', Buffer.from([0xff]), 422, 'INVALID_SOURCE'],
    ['deep.md', Buffer.from('> '.repeat(10_000) + 'x'), 413, 'LIMIT_EXCEEDED'],
  ]) {
    const upload = await app.inject({ method: 'POST', url: `${files.apiBase}/upload?name=${name}&operationId=${name}`,
      headers: { 'content-type': 'application/octet-stream', 'x-cockpit-module-digest': files.digest }, payload });
    assert.equal(upload.statusCode, 200, upload.body);
    const preview = await app.inject(`${upload.json().url}?preview=1`);
    assert.equal(preview.statusCode, status, preview.body);
    assert.equal(preview.json().code, code);
    assert.equal((await app.inject(`${upload.json().url}?download=1`)).rawPayload.compare(payload), 0);
  }
});
