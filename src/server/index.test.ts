import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { ModuleRequest, ModuleResponse, NativeObservation } from '@cockpit/module-api';
import { activate } from './index.ts';
import { encodeMessageReference } from '../shared/files.ts';

async function fixture(t: TestContext, config: Record<string, unknown> = {}) {
  const root = await mkdtemp(fileURLToPath(new URL('../../node_modules/service-fixture-', import.meta.url)));
  const cwd = join(root, 'work');
  await mkdir(cwd);
  const controller = new AbortController();
  const errors: unknown[] = [];
  const module = await activate({
    apiVersion: 1, moduleId: 'cockpit-file', dataRoot: join(root, 'data'),
    apiBase: '/_modules/cockpit-file/fixed-digest/api', config, signal: controller.signal,
    report: error => { errors.push(error); },
  });
  t.after(async () => {
    await module.dispose?.();
    controller.abort();
    await rm(root, { recursive: true, force: true });
  });
  const request = (method: string, path: string, patch: Partial<ModuleRequest> = {}) => {
    const route = module.routes.find(route => route.method === method && route.path === path);
    assert.ok(route, `${method} ${path}`);
    return Promise.resolve(route.handler({ params: {}, query: {}, headers: {}, body: undefined, signal: controller.signal, ...patch }));
  };
  let serial = 0;
  const event = (type: string, messageId: string, data: Record<string, unknown> = {}, directory = cwd) => {
    const observation: NativeObservation = {
      sessionId: 'synthetic-session', cwd: directory,
      event: { id: `event-${++serial}`, timestamp: new Date().toISOString(), type,
        ...(type === 'assistant.message_start' || type === 'assistant.message_delta' ? { ephemeral: true } : {}),
        data: { messageId, ...data } },
    };
    return module.events?.handle(observation);
  };
  const ref = (messageId: string, reference: string) =>
    encodeMessageReference({ sessionId: 'synthetic-session', messageId }, reference);
  const messageHead = (messageId: string, reference: string) =>
    request('HEAD', '/messages/*', { params: { '*': ref(messageId, reference) } });
  const ready = async (read: () => Promise<ModuleResponse>) => {
    const end = Date.now() + 4000;
    let result = await read();
    while ((result.status === 202 || result.status === 404) && Date.now() < end) {
      await delay(5); result = await read();
    }
    assert.ok(result.status === undefined || result.status === 200, JSON.stringify(result));
    return result;
  };
  return { root, cwd, module, request, event, ref, messageHead, ready, errors };
}

test('module upload returns the native attachment and supports HEAD, exact downloads and ranges', async t => {
  const f = await fixture(t);
  const uploaded = await f.request('POST', '/upload', {
    query: { name: 'report.txt', operationId: 'upload-1' },
    body: Readable.from([Buffer.from('abcdef')]), headers: { 'x-file-mime': 'image/png' },
  });
  const body = uploaded.body as { fileId: string; url: string; attachment: { type: string; path: string }; mime: string };
  assert.equal(body.attachment.type, 'file');
  assert.ok(body.attachment.path.startsWith(String(f.module.publicConfig?.nativePathPrefix)));
  assert.equal(body.mime, 'application/octet-stream');
  assert.match(body.url, /\/files\/f_[a-f0-9]{64}\/body\.txt$/);
  const params = { fileId: body.fileId, body: 'body.txt' };
  const head = await f.request('HEAD', '/files/:fileId/:body', { params });
  assert.equal(head.headers?.['Content-Length'], '6');
  assert.match(head.headers?.['Content-Disposition'] ?? '', /^attachment;/);
  const part = await f.request('GET', '/files/:fileId/:body', { params, headers: { range: 'bytes=1-3' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers?.['Content-Range'], 'bytes 1-3/6');
  assert.ok(part.body instanceof Readable);
  assert.equal(Buffer.concat(await part.body.toArray()).toString(), 'bcd');
  assert.equal((await f.request('GET', '/files/:fileId/:body', { params, headers: { range: 'bytes=99-' } })).status, 416);
  assert.equal((await f.request('GET', '/files/:fileId/:body', { params: { ...params, body: 'body.png' } })).status, 404);
});

test('historical completions and resource reads cannot import a local file', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'old.txt'), 'old bytes');
  await f.event('assistant.message', 'old-message', { content: '[old](./old.txt)' });
  assert.equal((await f.messageHead('old-message', './old.txt')).status, 404);
  const response = await f.request('GET', '/messages/*', {
    params: { '*': f.ref('old-message', './old.txt') },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await readdir(join(f.root, 'data', 'files')), []);
  assert.equal((await f.request('HEAD', '/messages/*', { params: { '*': 'invalid!' } })).status, 400);
});

test('new deltas capture once across fragment boundaries and new messages preserve different versions', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'a b.txt'), 'version one');
  await f.event('assistant.message_start', 'first');
  await f.event('assistant.message_delta', 'first', { deltaContent: '[result](<./a ' });
  assert.equal((await f.messageHead('first', './a b.txt')).status, 404);
  await f.event('assistant.message_delta', 'first', { deltaContent: 'b.txt>)' });
  await f.ready(() => f.messageHead('first', './a b.txt'));
  await writeFile(join(f.cwd, 'a b.txt'), 'version two');
  await f.event('assistant.message', 'first', { content: '[result](<./a b.txt>)' });
  await f.event('assistant.message_start', 'second');
  await f.event('assistant.message_delta', 'second', { deltaContent: '[new](<./a b.txt>)' });
  await f.ready(() => f.messageHead('second', './a b.txt'));
  for (const [message, expected] of [['first', 'version one'], ['second', 'version two']]) {
    const response = await f.request('GET', '/messages/*', {
      params: { '*': f.ref(message!, './a b.txt') },
    });
    assert.ok(response.body instanceof Readable);
    assert.equal(Buffer.concat(await response.body.toArray()).toString(), expected);
  }
  assert.equal((await readdir(join(f.root, 'data', 'files'))).length, 2);
  assert.deepEqual(f.errors, []);
});

test('one native response can schedule more references than the concurrent copy limit', async t => {
  const f = await fixture(t, { maxConcurrent: 1 });
  const links: string[] = [];
  for (let i = 0; i < 6; i++) {
    await writeFile(join(f.cwd, `${i}.txt`), `file ${i}`);
    links.push(`[${i}](./${i}.txt)`);
  }
  await f.event('assistant.message_start', 'many');
  await f.event('assistant.message_delta', 'many', { deltaContent: links.join('\n') });
  for (let i = 0; i < 6; i++) await f.ready(() => f.messageHead('many', `./${i}.txt`));
  assert.deepEqual(f.errors, []);
});

test('new references use the current native working directory without changing an earlier snapshot', async t => {
  const f = await fixture(t);
  const other = join(f.root, 'other');
  await mkdir(other);
  await writeFile(join(f.cwd, 'before.txt'), 'before');
  await writeFile(join(other, 'after.txt'), 'after');
  await f.event('assistant.message_start', 'moving');
  await f.event('assistant.message_delta', 'moving', { deltaContent: '[before](./before.txt)\n' });
  await f.ready(() => f.messageHead('moving', './before.txt'));
  await f.event('assistant.message_delta', 'moving', { deltaContent: '[after](./after.txt)' }, other);
  await f.ready(() => f.messageHead('moving', './after.txt'));
  assert.deepEqual(f.errors, []);
});
