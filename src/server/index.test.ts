import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises';
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
    invalidate() {},
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
  const event = (type: string, messageId: string, data: Record<string, unknown> = {}, directory = cwd,
    nativeContext: Pick<NativeObservation, 'workspacePath'> = { workspacePath: null }) => {
    const observation: NativeObservation = {
      sessionId: 'synthetic-session', cwd: directory, ...nativeContext,
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

test('SVG originals use image MIME with sandboxed resource headers and explicit downloads', async t => {
  const f = await fixture(t);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><style>rect{fill:red}</style><rect width="20" height="20"/><script>void 0</script></svg>';
  const uploaded = await f.request('POST', '/upload', {
    query: { name: 'drawing.svg', operationId: 'svg-upload' }, body: Readable.from([Buffer.from(svg)]),
  });
  const value = uploaded.body as { fileId: string; mime: string };
  assert.equal(value.mime, 'image/svg+xml');
  const params = { fileId: value.fileId, body: 'body.svg' };
  const preview = await f.request('GET', '/files/:fileId/:body', { params });
  assert.equal(preview.headers?.['Content-Type'], 'image/svg+xml');
  assert.match(preview.headers?.['Content-Disposition'] ?? '', /^inline;/);
  assert.equal(preview.headers?.['X-Content-Type-Options'], 'nosniff');
  assert.equal(preview.headers?.['Content-Security-Policy'],
    "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  assert.ok(preview.body instanceof Readable);
  assert.equal(Buffer.concat(await preview.body.toArray()).toString(), svg);
  const download = await f.request('HEAD', '/files/:fileId/:body', { params, query: { download: '1' } });
  assert.match(download.headers?.['Content-Disposition'] ?? '', /^attachment;/);
  await writeFile(join(f.cwd, 'picture.svg'), svg);
  await f.event('assistant.message_start', 'svg-message');
  await f.event('assistant.message_delta', 'svg-message', { deltaContent: '![picture](./picture.svg)' });
  const head = await f.ready(() => f.messageHead('svg-message', './picture.svg'));
  assert.equal(head.headers?.['Content-Type'], 'image/svg+xml');
  assert.deepEqual(f.errors, []);
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

test('artifact references preserve the raw message URL whether the unique source is project or SDK workspace', async t => {
  const f = await fixture(t);
  const workspacePath = join(f.root, 'custom-native-workspace');
  await mkdir(join(workspacePath, 'files'), { recursive: true });
  await mkdir(join(f.cwd, 'files'));
  const reference = 'files/seaside%20sunset.svg';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20"/></svg>';
  const file = 'seaside sunset.svg';
  for (const [message, root] of [['native-root', workspacePath], ['project-root', f.cwd]]) {
    const path = join(root!, 'files', file);
    await writeFile(path, svg);
    await f.event('assistant.message_start', message!, {}, f.cwd, { workspacePath });
    await f.event('assistant.message_delta', message!, { deltaContent: `![sunset](${reference})` }, f.cwd, { workspacePath });
    const head = await f.ready(() => f.messageHead(message!, reference));
    assert.equal(head.headers?.['Content-Type'], 'image/svg+xml');
    const result = await f.request('GET', '/messages/*', { params: { '*': f.ref(message!, reference) } });
    assert.ok(result.body instanceof Readable);
    assert.equal(Buffer.concat(await result.body.toArray()).toString(), svg);
    await rm(path);
    assert.equal((await f.messageHead(message!, reference)).status, undefined, 'snapshot survives source deletion');
  }
  assert.deepEqual(f.errors, []);
});

test('unknown workspace waits for native context and retains the reference-time project cwd', async t => {
  const f = await fixture(t);
  const workspacePath = join(f.root, 'native');
  const moved = join(f.root, 'moved');
  await mkdir(join(f.cwd, 'files'));
  await mkdir(moved);
  await writeFile(join(f.cwd, 'files', 'original.txt'), 'reference-time project');
  const reference = './files/original.txt';
  await f.event('assistant.message_start', 'early', {}, f.cwd, {});
  await f.event('assistant.message_delta', 'early', { deltaContent: `[file](${reference})` }, f.cwd, {});
  assert.equal((await f.messageHead('early', reference)).status, 404, 'unknown workspace must not silently mean no second source');
  await f.event('assistant.message', 'early', { content: `[file](${reference})` }, moved, { workspacePath });
  await f.ready(() => f.messageHead('early', reference));
  const response = await f.request('GET', '/messages/*', { params: { '*': f.ref('early', reference) } });
  assert.ok(response.body instanceof Readable);
  assert.equal(Buffer.concat(await response.body.toArray()).toString(), 'reference-time project');
  assert.deepEqual(f.errors, []);
});

test('missing workspace context stays explicit while a known absent workspace permits project artifacts', async t => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, 'files'));
  await writeFile(join(f.cwd, 'files', 'file.txt'), 'project');
  const content = '[file](files/file.txt)';
  await f.event('assistant.message_start', 'unknown', {}, f.cwd, {});
  await f.event('assistant.message_delta', 'unknown', { deltaContent: content }, f.cwd, {});
  await f.event('assistant.message', 'unknown', { content }, f.cwd, {});
  assert.equal((await f.messageHead('unknown', 'files/file.txt')).status, 404);
  assert.match(String(f.errors[0]), /workspace context unavailable/);
  await f.event('assistant.message_start', 'no-workspace');
  await f.event('assistant.message_delta', 'no-workspace', { deltaContent: content });
  await f.ready(() => f.messageHead('no-workspace', 'files/file.txt'));
});

test('two existing artifact candidates fail rather than guessing or reopening historical references', async t => {
  const f = await fixture(t);
  const workspacePath = join(f.root, 'native');
  for (const root of [f.cwd, workspacePath]) {
    await mkdir(join(root, 'files'), { recursive: true });
    await writeFile(join(root, 'files', 'ambiguous.txt'), root);
  }
  const content = '[file](files/ambiguous.txt)';
  await f.event('assistant.message_start', 'ambiguous', {}, f.cwd, { workspacePath });
  await f.event('assistant.message_delta', 'ambiguous', { deltaContent: content }, f.cwd, { workspacePath });
  let response = await f.messageHead('ambiguous', 'files/ambiguous.txt');
  const deadline = Date.now() + 4000;
  while ([202, 404].includes(response.status ?? 200) && Date.now() < deadline) {
    await delay(5);
    response = await f.messageHead('ambiguous', 'files/ambiguous.txt');
  }
  assert.equal(response.status, 422);
  const result = await f.request('GET', '/messages/*', { params: { '*': f.ref('ambiguous', 'files/ambiguous.txt') } });
  assert.equal((result.body as { code: string }).code, 'AMBIGUOUS_SOURCE');
  await rm(join(f.cwd, 'files', 'ambiguous.txt'));
  await f.event('assistant.message', 'ambiguous', { content }, f.cwd, { workspacePath });
  assert.equal((await f.messageHead('ambiguous', 'files/ambiguous.txt')).status, 422);
  while (!f.errors.length && Date.now() < deadline) await delay(5);
  assert.equal(f.errors.length, 1);
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

test('DELETE uploads returns 204, removes the original, and returns ordinary missing reads and terminal retries', async t => {
  const f = await fixture(t);
  const uploaded = await f.request('POST', '/upload', {
    query: { name: 'draft.txt', operationId: 'draft-discard' }, body: Readable.from([Buffer.from('draft')]),
  });
  const body = uploaded.body as { fileId: string; attachment: { path: string } };
  const params = { operationId: 'draft-discard' };
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = await f.request('DELETE', '/uploads/:operationId', { params });
    assert.equal(response.status, 204);
    assert.equal(response.body, undefined);
    assert.equal(response.headers?.['Cache-Control'], 'no-store');
  }
  await assert.rejects(stat(body.attachment.path), { code: 'ENOENT' });
  for (const method of ['GET', 'HEAD']) {
    const response = await f.request(method, '/files/:fileId/:body', { params: { fileId: body.fileId, body: 'body.txt' } });
    assert.equal(response.status, 404);
    assert.equal(response.headers?.['X-File-State'], 'missing');
  }
  const retry = await f.request('POST', '/upload', {
    query: { name: 'draft.txt', operationId: 'draft-discard' }, body: Readable.from([Buffer.from('draft')]),
  });
  assert.equal(retry.status, 410);
  assert.equal((retry.body as { code: string }).code, 'DISCARDED');
});

test('DELETE bypasses the upload queue, cancels its active upload, and fences a not-yet-started upload', async t => {
  const f = await fixture(t, { maxConcurrent: 1 });
  const input = new Readable({ read() {} });
  const active = f.request('POST', '/upload', {
    query: { name: 'active.txt', operationId: 'active' }, body: input,
  });
  const queued = f.request('POST', '/upload', {
    query: { name: 'queued.txt', operationId: 'queued' }, body: Readable.from([Buffer.from('queued')]),
  });
  const disconnected = new AbortController();
  disconnected.abort(new Error('browser disconnected'));
  const removedQueued = await f.request('DELETE', '/uploads/:operationId', {
    params: { operationId: 'queued' }, signal: disconnected.signal,
  });
  assert.equal(removedQueued.status, 204);
  const removedActive = await f.request('DELETE', '/uploads/:operationId', { params: { operationId: 'active' } });
  assert.equal(removedActive.status, 204);
  assert.equal((await active).status, 409);
  assert.equal((await queued).status, 410);
  assert.equal(input.destroyed, true);
  for (const id of await readdir(join(f.root, 'data', 'files'))) {
    assert.deepEqual((await readdir(join(f.root, 'data', 'files', id))).sort(), ['discarded.json', 'identity.json']);
  }
});

test('DELETE reports invalid operation identities, unknown ownership, and storage errors explicitly', async t => {
  const f = await fixture(t);
  for (const operationId of ['', '../body', '/native/path', 'bad\nid', `f_${'a'.repeat(64)}`]) {
    const invalid = await f.request('DELETE', '/uploads/:operationId', { params: { operationId } });
    assert.equal(invalid.status, 400);
    assert.equal((invalid.body as { code: string }).code, 'INVALID_INPUT');
  }
  const uploaded = await f.request('POST', '/upload', {
    query: { name: 'foreign.txt', operationId: 'foreign' }, body: Readable.from([Buffer.from('keep')]),
  });
  const body = uploaded.body as { fileId: string };
  const slot = join(f.root, 'data', 'files', body.fileId);
  await mkdir(join(slot, 'attempt'), { mode: 0o700 });
  const foreign = await f.request('DELETE', '/uploads/:operationId', { params: { operationId: 'foreign' } });
  assert.equal(foreign.status, 409);
  assert.equal((foreign.body as { code: string }).code, 'ACTIVITY_UNKNOWN');
  await assert.rejects(stat(join(slot, 'discarded.json')), { code: 'ENOENT' });
  const disconnected = new AbortController();
  disconnected.abort();
  assert.equal((await f.request('DELETE', '/uploads/:operationId', {
    params: { operationId: 'foreign' }, signal: disconnected.signal,
  })).status, 409);
  assert.equal(f.errors.length, 1, 'discard failures after disconnect are still reported to the host');
  await rm(join(slot, 'attempt'), { recursive: true });
  await mkdir(join(slot, 'discarded.json'), { mode: 0o700 });
  const failure = await f.request('DELETE', '/uploads/:operationId', { params: { operationId: 'foreign' } });
  assert.equal(failure.status, 500);
  assert.equal((failure.body as { code: string }).code, 'IO_ERROR');
});
