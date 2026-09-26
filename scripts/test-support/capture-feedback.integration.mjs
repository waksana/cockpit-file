import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function writableTree(root) {
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) return;
  await chmod(root, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) {
    for (const name of await readdir(root)) await writableTree(join(root, name));
  }
}

test('missing capture sources stay local across real host bootstraps and historical reads', {
  skip: !process.env.COCKPIT_HOST_SOURCE || !process.env.COCKPIT_FILE_MODULE_ARCHIVE,
  timeout: 30_000,
}, async t => {
  const hostSource = resolve(process.env.COCKPIT_HOST_SOURCE);
  const archive = resolve(process.env.COCKPIT_FILE_MODULE_ARCHIVE);
  const require = createRequire(join(hostSource, 'apps/server/package.json'));
  const Fastify = require('fastify');
  const { ModuleHost } = await import(pathToFileURL(join(hostSource, 'apps/server/src/module-host.ts')).href);
  const { installLocalModule } = await import(pathToFileURL(join(hostSource, 'apps/server/src/module-install.ts')).href);
  const root = await mkdtemp(fileURLToPath(new URL('../../node_modules/capture-feedback-host-', import.meta.url)));
  const hostRoot = join(root, 'home');
  const cwd = join(root, 'sources');
  await mkdir(cwd);
  const observers = new Set();
  const errors = [];
  const host = new ModuleHost({
    hostRoot,
    observer: {
      onNativeEvent(handler) {
        observers.add(handler);
        return () => observers.delete(handler);
      },
    },
    report: (_id, error) => errors.push(error),
  });
  const app = Fastify();
  t.after(async () => {
    host.close();
    await app.close();
    await writableTree(root);
    await rm(root, { recursive: true, force: true });
  });
  const installed = await installLocalModule(archive, { hostRoot, trustLocalCode: true, enable: true });
  await host.register(app);
  await app.ready();
  const initial = (await app.inject('/_modules')).json();
  assert.deepEqual(initial.errors, []);
  assert.equal(initial.active.length, 1);
  assert.equal(initial.active[0].digest, installed.digest);
  const apiBase = initial.modules[0].apiBase;
  const sessionId = '11111111-1111-4111-8111-111111111111';
  let serial = 0;
  const emit = async (type, messageId, data = {}) => {
    const event = {
      sessionId, cwd, workspacePath: null,
      event: {
        id: `fixture-${++serial}`, type, timestamp: new Date().toISOString(),
        ...(type !== 'assistant.message' ? { ephemeral: true } : {}),
        data: { messageId, ...data },
      },
    };
    for (const handler of observers) await handler(event);
  };
  const messageUrl = (id, reference) =>
    `${apiBase}/messages/${Buffer.from(JSON.stringify([sessionId, id, reference])).toString('base64url')}`;
  const settledHead = async url => {
    const deadline = Date.now() + 5_000;
    let response = await app.inject({ method: 'HEAD', url });
    while ([202, 404].includes(response.statusCode) && Date.now() < deadline) {
      await delay(5);
      response = await app.inject({ method: 'HEAD', url });
    }
    return response;
  };
  const missingUrl = messageUrl('missing', './missing.txt');
  await emit('assistant.message_start', 'missing');
  await emit('assistant.message_delta', 'missing', { deltaContent: '[missing](./missing.txt)' });
  assert.equal((await settledHead(missingUrl)).statusCode, 422);
  assert.equal((await app.inject(missingUrl)).json().code, 'SOURCE_NOT_FOUND');
  await emit('assistant.message', 'missing', { content: '[missing](./missing.txt)' });

  await writeFile(join(cwd, 'saved.txt'), 'saved snapshot');
  await emit('assistant.message_start', 'saved');
  await emit('assistant.message_delta', 'saved', { deltaContent: '[saved](./saved.txt)' });
  const savedUrl = messageUrl('saved', './saved.txt');
  assert.equal((await settledHead(savedUrl)).statusCode, 200);
  await rm(join(cwd, 'saved.txt'));
  assert.equal((await app.inject(savedUrl)).body, 'saved snapshot');

  await writeFile(join(cwd, 'missing.txt'), 'created after the failed capture');
  const bootstraps = [];
  for (let i = 0; i < 3; i++) {
    bootstraps.push((await app.inject('/_modules')).json());
    await emit('assistant.message', 'missing', { content: '[missing](./missing.txt)' });
    assert.equal((await app.inject({ method: 'HEAD', url: missingUrl })).statusCode, 422);
    assert.equal((await app.inject(missingUrl)).json().code, 'SOURCE_NOT_FOUND');
  }
  await emit('assistant.message_start', 'new-message');
  await emit('assistant.message_delta', 'new-message', { deltaContent: '[now available](./missing.txt)' });
  const newUrl = messageUrl('new-message', './missing.txt');
  assert.equal((await settledHead(newUrl)).statusCode, 200);
  assert.equal((await app.inject(newUrl)).body, 'created after the failed capture');
  t.diagnostic(JSON.stringify({
    reportedCodes: errors.map(error => error.code),
    bootstrapErrorCounts: bootstraps.map(snapshot => snapshot.errors.length),
    missingStatus: 422, savedStatus: 200, newMessageStatus: 200,
  }));
  for (const snapshot of bootstraps) {
    assert.deepEqual(snapshot.active, initial.active);
    assert.deepEqual(snapshot.errors, [], 'A missing source must not become a retained module runtime error');
  }
  assert.deepEqual(errors, []);
  const failedHead = await app.inject({ method: 'HEAD', url: missingUrl });
  assert.equal(failedHead.headers['x-file-state'], 'failed');
  assert.equal(failedHead.headers['x-file-error-code'], 'SOURCE_NOT_FOUND');
});
