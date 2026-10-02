import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { join, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const source = process.env.COCKPIT_HOST_SOURCE;
if (!source) throw new Error('COCKPIT_HOST_SOURCE must identify the pinned integration host');
const load = path => import(pathToFileURL(resolve(source, path)).href);
const require = createRequire(resolve(source, 'apps/server/package.json'));
const Fastify = require('fastify');
const { harness } = await load('packages/core/test-support/engine-harness.ts');
const { moduleEntries, moduleFixture } = await load('apps/server/src/test-support/module-fixture.ts');
const { ModuleHost } = await load('apps/server/src/module-host.ts');
const { installLocalModule } = await load('apps/server/src/module-install.ts');
process.env.COCKPIT_NO_BOOT = '1';
process.env.LOG_LEVEL = 'silent';
process.env.COCKPIT_SERVE_WEB = '0';
const { app, setTestDependencies, callModuleIntent } = await load('apps/server/src/index.ts');
after(() => app.close());

test('packaged Files transparently wraps Web/API and another module host.call with native receipts', async t => {
  const f = await moduleFixture(t);
  const h = harness(t);
  const installed = await installLocalModule(resolve(process.env.COCKPIT_FILE_MODULE_ARCHIVE),
    { hostRoot: f.hostRoot, trustLocalCode: true, enable: true });
  await installLocalModule(await f.package(moduleEntries('relay', `
    export function activate(context) {
      return { routes: [{ method: 'POST', path: '/send', body: 'json',
        handler: async request => ({ body: await context.host.call('prompt', request.body) }) }] };
    }
  `)), { hostRoot: f.hostRoot, trustLocalCode: true, enable: true });
  const moduleApp = Fastify();
  const host = new ModuleHost({ hostRoot: f.hostRoot, observer: h.engine, host: { call: callModuleIntent } });
  await host.register(moduleApp);
  await moduleApp.ready();
  setTestDependencies({ engine: h.engine, moduleHost: host });
  t.after(async () => { await host.close(); await moduleApp.close(); });
  assert.deepEqual(host.bootstrap().errors, []);
  const files = host.bootstrap().modules.find(item => item.id === 'cockpit-file');
  const relay = host.bootstrap().modules.find(item => item.id === 'relay');
  assert.equal(files.digest, installed.digest);
  const session = await h.load();
  const path = join(f.root, 'synthetic-source.txt');
  await writeFile(path, 'native attachment bytes');
  const accepted = [];
  h.engine.onPromptAccepted(event => accepted.push(event));
  for (const origin of ['user', 'api', 'module']) {
    const payload = { sessionId: session.id, text: 'unchanged text', mode: 'enqueue',
      attachments: [{ type: 'file', path, displayName: 'synthetic' }, { type: 'directory', path: '/native-directory' }] };
    const response = origin === 'module'
      ? await moduleApp.inject({ method: 'POST', url: `${relay.apiBase}/send`, payload,
        headers: { 'x-cockpit-module-digest': relay.digest } })
      : await app.inject({ method: 'POST', url: '/intent/prompt', payload,
        headers: origin === 'user'
          ? { host: 'synthetic.test', origin: 'https://synthetic.test', 'sec-fetch-site': 'same-origin' } : {} });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().messageId, accepted.at(-1).messageId);
    assert.equal(accepted.at(-1).origin, origin);
    const sent = session.sdk.send.mock.calls.at(-1).arguments[0];
    assert.equal(sent.prompt, payload.text);
    assert.equal(sent.mode, payload.mode);
    assert.deepEqual(sent.attachments[1], payload.attachments[1]);
    assert.notEqual(sent.attachments[0].path, path);
    assert.equal(await readFile(sent.attachments[0].path, 'utf8'), 'native attachment bytes');
    const suffix = sent.attachments[0].path.slice(files.config.nativePathPrefix.length).replace('/ready/', '/');
    assert.equal((await moduleApp.inject(`${files.apiBase}/files/${suffix}`)).body, 'native attachment bytes');
  }
  assert.equal(session.sdk.send.mock.callCount(), 3);
  const uploaded = await moduleApp.inject({ method: 'POST',
    url: `${files.apiBase}/upload?name=web.txt&operationId=web-synthetic`,
    headers: { 'content-type': 'application/octet-stream', 'x-cockpit-module-digest': files.digest },
    payload: Buffer.from('web bytes') });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const attachment = uploaded.json().attachment;
  const web = await app.inject({ method: 'POST', url: '/intent/prompt',
    payload: { sessionId: session.id, text: '', attachments: [attachment] } });
  assert.equal(web.statusCode, 200, web.body);
  assert.deepEqual(session.sdk.send.mock.calls.at(-1).arguments[0].attachments, [attachment]);
  const missing = await app.inject({ method: 'POST', url: '/intent/prompt',
    payload: { sessionId: session.id, text: 'must not send', attachments: [{ type: 'file', path: `${path}-missing` }] } });
  assert.notEqual(missing.statusCode, 200);
  assert.equal(session.sdk.send.mock.callCount(), 4);
  assert.equal(await readFile(path, 'utf8'), 'native attachment bytes');
});

test('the same host keeps native prompt behavior with no Files module', async t => {
  const f = await moduleFixture(t);
  const h = harness(t);
  const moduleApp = Fastify();
  const host = new ModuleHost({ hostRoot: f.hostRoot, observer: h.engine, host: { call: callModuleIntent } });
  await host.register(moduleApp);
  setTestDependencies({ engine: h.engine, moduleHost: host });
  t.after(async () => { await host.close(); await moduleApp.close(); });
  const session = await h.load();
  const attachments = [{ type: 'file', path: '/unchanged-native-path' }];
  const response = await app.inject({ method: 'POST', url: '/intent/prompt',
    payload: { sessionId: session.id, text: '', attachments } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(session.sdk.send.mock.calls[0].arguments[0].attachments, attachments);
});
