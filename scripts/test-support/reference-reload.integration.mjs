import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const source = process.env.COCKPIT_HOST_SOURCE;
if (!source) throw new Error('COCKPIT_HOST_SOURCE must identify the pinned integration host');
const load = path => import(pathToFileURL(resolve(source, path)).href);
const require = createRequire(resolve(source, 'apps/server/package.json'));
const Fastify = require('fastify');
const { harness, event, assistant } = await load('packages/core/test-support/engine-harness.ts');
const { moduleFixture } = await load('apps/server/src/test-support/module-fixture.ts');
const { ModuleHost } = await load('apps/server/src/module-host.ts');
const { installLocalModule } = await load('apps/server/src/module-install.ts');
process.env.COCKPIT_NO_BOOT = '1';
process.env.LOG_LEVEL = 'silent';
process.env.COCKPIT_SERVE_WEB = '0';
const { app, setTestDependencies, callModuleIntent } = await load('apps/server/src/index.ts');
after(() => app.close());

test('packaged reload uses passive native history, digest protection and immutable one-reference capture', async t => {
  const f = await moduleFixture(t);
  const h = harness(t);
  await installLocalModule(resolve(process.env.COCKPIT_FILE_MODULE_ARCHIVE),
    { hostRoot: f.hostRoot, trustLocalCode: true, enable: true });
  const moduleApp = Fastify();
  let gate;
  const host = new ModuleHost({ hostRoot: f.hostRoot, observer: h.engine, host: {
    async call(name, body) {
      assert.equal(name, 'session/chat');
      if (gate) await gate;
      return callModuleIntent(name, body);
    },
  } });
  await host.register(moduleApp);
  await moduleApp.ready();
  setTestDependencies({ engine: h.engine, moduleHost: host });
  t.after(async () => { await host.close(); await moduleApp.close(); });
  assert.deepEqual(host.bootstrap().errors, []);
  const files = host.bootstrap().modules.find(item => item.id === 'cockpit-file');
  const session = await h.seed();
  const path = join(f.root, 'missed.txt');
  const missing = join(f.root, 'later.txt');
  await writeFile(path, 'the current source, not the old message bytes');
  h.journals.set(session.id, [
    event('session.start', { sessionId: session.id, context: { cwd: f.root } }),
    assistant('event-id-not-message-id', 'missed-message', `[missed](${path})`),
    assistant('missing-event', 'missing-message', `[missing](${missing})`),
    assistant('relative-event', 'relative-message', '[relative](./missed.txt)'),
    ...Array.from({ length: 70 }, () => event('session.title_changed', { title: 'synthetic padding' })),
  ]);
  const url = (messageId, reference) =>
    `${files.apiBase}/messages/${Buffer.from(JSON.stringify([session.id, messageId, reference])).toString('base64url')}`;
  const reload = (target, operationId = randomUUID(), headers = { 'x-cockpit-module-digest': files.digest }) =>
    moduleApp.inject({ method: 'POST', url: target, headers, payload: { operationId } });
  const target = url('missed-message', path);
  assert.equal((await moduleApp.inject({ method: 'HEAD', url: target })).statusCode, 404);
  assert.equal((await moduleApp.inject(target)).statusCode, 404);
  assert.equal(h.runtime.rpc.sessions.readPersistedEvents.mock.callCount(), 0, 'GET/HEAD never scan history');
  assert.equal((await reload(target, randomUUID(), {})).statusCode, 409, 'Host enforces the module digest');
  assert.equal((await reload(url('missed-message', missing))).json().code, 'REFERENCE_MISMATCH');
  assert.equal((await reload(url('event-id-not-message-id', path))).json().code, 'REFERENCE_MISMATCH');

  let release;
  gate = new Promise(resolve => { release = resolve; });
  const first = reload(target);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await reload(target)).statusCode, 202, 'concurrent click is not a second source read');
  release();
  gate = undefined;
  const ready = await first;
  assert.equal(ready.statusCode, 200, ready.body);
  assert.equal(ready.json().state, 'ready');
  assert.match(ready.json().note, /not necessarily the original message time/);
  assert.equal((await moduleApp.inject(target)).body, 'the current source, not the old message bytes');
  await writeFile(path, 'changed later');
  assert.equal((await reload(target)).json().fileId, ready.json().fileId);
  assert.equal((await moduleApp.inject(target)).body, 'the current source, not the old message bytes');

  const missingTarget = url('missing-message', missing);
  const operationId = randomUUID();
  assert.equal((await reload(missingTarget, operationId)).json().code, 'SOURCE_NOT_FOUND');
  await writeFile(missing, 'appeared later');
  assert.equal((await reload(missingTarget, operationId)).json().code, 'RELOAD_REPLAY');
  assert.equal((await moduleApp.inject(missingTarget)).statusCode, 422);
  assert.equal((await reload(missingTarget)).statusCode, 200);
  assert.equal((await moduleApp.inject(missingTarget)).body, 'appeared later');
  assert.equal((await reload(url('relative-message', './missed.txt'))).statusCode, 200);

  assert.equal(h.runtime.resumeSession.mock.callCount(), 0);
  assert.equal(h.runtime.createSession.mock.callCount(), 0);
  assert.equal(session.sdk.send.mock.callCount(), 0);
  assert.equal(session.sdk.getEvents.mock.callCount(), 0);
  const reads = h.runtime.rpc.sessions.readPersistedEvents.mock.calls;
  assert.ok(reads.some(call => call.arguments[0].cursor), 'older exact references use native paging');
  assert.ok(reads.every(call => call.arguments[0].max === 64 && call.arguments[0].direction === 'backward'));
  t.diagnostic(JSON.stringify({ passiveNativePages: reads.length, resume: 0, prompt: 0, ready: ready.json().fileId }));
});
