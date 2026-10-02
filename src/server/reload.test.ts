import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import type { ModuleHostApi, ModuleHostIntentBody, NativeChatEvent } from '@waksana/cockpit-module-sdk/backend';
import { encodeMessageReference } from '../shared/files.ts';
import { reloadSource } from './reload.ts';
import { createFileStorage } from './storage.ts';
import { activate } from './index.ts';

const origin = { sessionId: 'synthetic-session', messageId: 'native-message' };
const encode = (reference: string) => encodeMessageReference(origin, reference);
const message = (content: string): NativeChatEvent => ({
  id: 'native-event', type: 'assistant.message', data: { messageId: origin.messageId, content },
});
function history(pages: NativeChatEvent[][], change = {}) {
  const calls: ModuleHostIntentBody<'session/chat'>[] = [];
  const host: ModuleHostApi = {
    async call(name, body) {
      assert.equal(name, 'session/chat');
      calls.push(body as ModuleHostIntentBody<'session/chat'>);
      const index = calls.length - 1;
      return {
        sessionId: origin.sessionId, source: 'persisted', direction: 'backward', cursorStatus: 'ok',
        cursor: `cursor-${index}`, events: pages[index] ?? [], hasMore: index < pages.length - 1,
        read: { events: pages[index]?.length ?? 0, rpc: 1 }, ...change,
      } as never;
    },
  };
  return { host, calls };
}

test('reload validates exact native assistant reference and uses passive bounded history only', async () => {
  const reference = '/synthetic/a%20b.txt';
  const h = history([[{ id: 'user', type: 'user.message', data: { content: 'irrelevant' } }],
    [message(`[download](${reference})`)]]);
  assert.deepEqual(await reloadSource(h.host, encode(reference), new AbortController().signal),
    { origin, reference, path: '/synthetic/a b.txt' });
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0], { sessionId: origin.sessionId, source: 'persisted', direction: 'backward',
    max: 64, waitMs: 0, bootstrap: false });
  assert.equal(h.calls[1]!.cursor, 'cursor-0');
});

test('reload rejects forged identity, exact-target mismatch, code, user text, expired and over-budget history', async () => {
  for (const events of [
    [message('[other](/synthetic/other)')],
    [message('`[fake](/synthetic/file)`')],
    [message('> ~~~\n> [fake](/synthetic/file)\n> ~~~')],
    [message('- ~~~\n  [fake](/synthetic/file)\n  ~~~')],
    [message('<div>\n[fake](/synthetic/file)\n</div>')],
    [message('    [fake](/synthetic/file)')],
    [{ ...message('[file](/synthetic/file)'), type: 'user.message' }],
    [{ ...message('[file](/synthetic/file)'), ephemeral: true }],
  ]) await assert.rejects(reloadSource(history([events]).host, encode('/synthetic/file'), new AbortController().signal));
  for (const change of [{ cursorStatus: 'expired' }, { sessionId: 'wrong-session' }, { source: 'live' }]) {
    await assert.rejects(reloadSource(history([[message('[file](/synthetic/file)')]], change).host,
      encode('/synthetic/file'), new AbortController().signal), /confirmed/);
  }
  const large = message('x'.repeat(8 * 1024 * 1024));
  await assert.rejects(reloadSource(history([[large]]).host, encode('/synthetic/file'), new AbortController().signal), /budget/);
  const endless = history(Array.from({ length: 33 }, () => []));
  await assert.rejects(reloadSource(endless.host, encode('/synthetic/file'), new AbortController().signal), /2048/);
  assert.equal(endless.calls.length, 32);
  const abort = new AbortController(); abort.abort();
  const never = history([]);
  await assert.rejects(reloadSource(never.host, encode('/synthetic/file'), abort.signal));
  assert.equal(never.calls.length, 0);
  for (const text of ['> [real](/synthetic/file)', '- [real](/synthetic/file)', '~~[real](/synthetic/file)~~']) {
    assert.equal((await reloadSource(history([[message(text)]]).host, encode('/synthetic/file'),
      new AbortController().signal)).path, '/synthetic/file');
  }
});

test('relative paths use preceding native root context, never current cwd or guessed SDK workspace', async () => {
  const context: NativeChatEvent = { id: 'context', type: 'session.context_changed', data: { cwd: '/native/then' } };
  const h = history([[message('[file](./a.txt)'), { ...context, id: 'later', data: { cwd: '/native/later' } }], [context]]);
  assert.equal((await reloadSource(h.host, encode('./a.txt'), new AbortController().signal)).path, '/native/then/a.txt');
  await assert.rejects(reloadSource(history([[context, message('[file](files/a.txt)')]]).host,
    encode('files/a.txt'), new AbortController().signal), /workspace/);
  await assert.rejects(reloadSource(history([[message('[file](./a.txt)')]]).host,
    encode('./a.txt'), new AbortController().signal), /directory/);
  await assert.rejects(reloadSource(history([[context, { ...message('[file](./a.txt)'), agentId: 'child' }]]).host,
    encode('./a.txt'), new AbortController().signal), /child message/);
});

async function storageFixture(t: TestContext) {
  const root = await mkdtemp(fileURLToPath(new URL('../../node_modules/reload-fixture-', import.meta.url)));
  const storage = await createFileStorage({ root: join(root, 'data'), maxBytes: 32 });
  t.after(async () => { await storage.close(); await rm(root, { recursive: true, force: true }); });
  const path = join(root, 'source.txt');
  return { root, storage, path };
}

test('explicit failed capture reload retains failure evidence, protects replay and publishes current bytes once', async t => {
  const f = await storageFixture(t);
  await assert.rejects(f.storage.capture('message', 'reference', f.path), /not found/);
  const operation = randomUUID();
  await assert.rejects(f.storage.reloadCapture('message', 'reference', f.path, operation), /not found/);
  await writeFile(f.path, 'current bytes');
  await assert.rejects(f.storage.reloadCapture('message', 'reference', f.path, operation), /already ran/);
  const stillFailed = await f.storage.lookupCapture('message', 'reference');
  assert.equal(stillFailed.state, 'failed');
  const saved = await f.storage.reloadCapture('message', 'reference', f.path, randomUUID());
  assert.equal(await readFile(saved.path, 'utf8'), 'current bytes');
  const records = (await readdir(join(f.storage.root, 'files', saved.id))).filter(name => name.startsWith('reload-'));
  assert.equal(records.length, 2);
  const prior = JSON.parse(await readFile(join(f.storage.root, 'files', saved.id, records[0]!), 'utf8'));
  assert.equal(prior.previousState.error.code, 'SOURCE_NOT_FOUND');
  await writeFile(f.path, 'later bytes');
  assert.deepEqual(await f.storage.reloadCapture('message', 'reference', f.path, randomUUID()), saved);
  assert.equal(await readFile(saved.path, 'utf8'), 'current bytes');
});

test('explicit reload cannot repair corrupt ready bytes, unknown owners or pending reservations', async t => {
  const f = await storageFixture(t);
  await writeFile(f.path, 'source');
  const saved = await f.storage.reloadCapture('message', 'reference', f.path, randomUUID());
  await writeFile(saved.path, 'tamper');
  await assert.rejects(f.storage.reloadCapture('message', 'reference', f.path, randomUUID()), /changed/);
  await assert.rejects(f.storage.capture('unknown', 'reference', '/missing'));
  const state = await f.storage.lookupCapture('unknown', 'reference');
  assert.equal(state.state, 'failed');
  if (state.state !== 'failed') assert.fail();
  const slot = join(f.storage.root, 'files', state.fileId);
  await writeFile(join(slot, 'state.json'), JSON.stringify({ state: 'pending', owner: { pid: 123456789, operation: randomUUID() } }));
  await mkdir(join(slot, 'attempt'), { mode: 0o700 });
  await assert.rejects(f.storage.reloadCapture('unknown', 'reference', f.path, randomUUID()), /another process|confirmed/);
  assert.equal(await readFile(f.path, 'utf8'), 'source');
});

test('module reload endpoint authorizes history before copying and rejects arbitrary bodies, duplicate clicks and stop', async t => {
  const root = await mkdtemp(fileURLToPath(new URL('../../node_modules/reload-route-', import.meta.url)));
  const source = join(root, 'current.txt');
  await writeFile(source, 'current file');
  const stopping = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = history([[message(`[file](${source})`)], [message(`[file](${source})`)]]);
  const module = await activate({
    apiVersion: 1, serviceReadyVersion: 1, shutdownVersion: 1, stopping: stopping.signal, signal: stopping.signal,
    moduleId: 'cockpit-file', dataRoot: join(root, 'data'), apiBase: '/module/api', config: {},
    report() {}, invalidate() {}, publish() {},
    host: { interfaceMiddlewareVersion: 1, chatReadVersion: 1, async call(name, body) {
      await gate;
      return h.host.call(name, body);
    } },
  });
  t.after(async () => { await module.dispose?.(); await rm(root, { recursive: true, force: true }); });
  const route = module.routes.find(route => route.method === 'POST' && route.path === '/messages/*')!;
  const send = (reference = source, body: unknown = { operationId: randomUUID() }) => Promise.resolve(route.handler({
    params: { '*': encode(reference) }, query: {}, headers: {}, body, signal: new AbortController().signal,
  }));
  assert.equal((await send(source, { path: '/arbitrary' })).status, 400);
  const first = send();
  assert.equal((await send()).status, 202, 'second click never queues a second capture');
  release();
  const ready = await first;
  assert.equal(ready.status, undefined);
  assert.equal((ready.body as { state: string }).state, 'ready');
  const before = await readFile(source, 'utf8');
  await writeFile(source, 'new source');
  const same = await send();
  assert.deepEqual(same.body, ready.body);
  const fileId = (ready.body as { fileId: string }).fileId;
  assert.equal(await readFile(join(root, 'data', 'files', fileId, 'ready', 'body.txt'), 'utf8'), before);
  stopping.abort();
  await module.onStop?.();
  assert.equal((await send()).status, 503);
});
