import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createFileStorage, DEFAULT_MAX_BYTES, FileStorageError } from './storage.ts';
import type { FileStorage, FileStorageOptions } from './storage.ts';

async function fixture(t: TestContext, options: Omit<FileStorageOptions, 'root'> = {}) {
  const parent = resolve('node_modules', '.file-storage-fixtures', randomUUID());
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = join(parent, 'data');
  const instances: FileStorage[] = [];
  t.after(async () => {
    for (const instance of instances) await instance.close();
    await rm(parent, { recursive: true, force: true });
  });
  const reopen = async () => {
    const storage = await createFileStorage({ root, ...options });
    instances.push(storage);
    return storage;
  };
  return { parent, root, storage: await reopen(), reopen };
}
function bytes(value: string | Uint8Array): Readable {
  return Readable.from([typeof value === 'string' ? Buffer.from(value) : value]);
}
async function read(storage: FileStorage, id: string, range?: { start: number; end?: number }) {
  const opened = await storage.openFile(id, range);
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return { ...opened, bytes: Buffer.concat(chunks) };
}
function code(expected: string) {
  return (error: unknown) => error instanceof FileStorageError && error.code === expected;
}

test('streamed upload commits original and per-file JSON together with a safe stable identity', async t => {
  const { storage, root } = await fixture(t);
  const chunks = [Buffer.from('hello'), Buffer.from(' world')];
  const saved = await storage.upload('operation-1', Readable.from(chunks), '../../report.txt', 'text/html');
  assert.match(saved.id, /^f_[a-f0-9]{64}$/);
  assert.equal(saved.name, 'report.txt');
  assert.equal(saved.size, 11);
  assert.equal(saved.sha256, createHash('sha256').update('hello world').digest('hex'));
  assert.equal(saved.mime, 'application/octet-stream');
  assert.equal(saved.inline, false);
  assert.equal(saved.path, join(root, 'files', saved.id, 'ready', 'body.txt'));
  assert.deepEqual(await storage.lookupUpload('operation-1'), { state: 'ready', file: saved });
  assert.deepEqual(await storage.lookupFile(saved.id), { state: 'ready', file: saved });
  assert.equal((await read(storage, saved.id)).bytes.toString(), 'hello world');
  assert.ok((await stat(root)).mode & 0o700);
  assert.equal((await stat(root)).mode & 0o077, 0);
  assert.deepEqual(await readdir(join(root, 'staging')), []);
  assert.deepEqual((await readdir(dirname(saved.path))).sort(), ['body.txt', 'metadata.json']);
});

test('same-operation retries verify bytes and names without overwrite; new uploads keep independent bytes', async t => {
  const { storage, reopen } = await fixture(t);
  const first = await storage.upload('one', bytes('same bytes'), 'a.txt');
  const retry = await storage.upload('one', bytes('same bytes'), 'a.txt');
  assert.deepEqual(retry, first);
  await assert.rejects(storage.upload('one', bytes('different'), 'a.txt'), code('CONFLICT'));
  await assert.rejects(storage.upload('one', bytes('same bytes'), 'b.txt'), code('CONFLICT'));
  const second = await storage.upload('two', bytes('same bytes'), 'a.txt');
  assert.notEqual(second.id, first.id);
  assert.notEqual((await stat(first.path)).ino, (await stat(second.path)).ino);
  await storage.close();
  const restarted = await reopen();
  assert.deepEqual(await restarted.upload('one', bytes('same bytes'), 'a.txt'), first);
  assert.equal((await read(restarted, first.id)).bytes.toString(), 'same bytes');
});

test('byte-exact configurable limits, empty files, and explicit failed-upload retry', async t => {
  const { storage, root } = await fixture(t, { maxBytes: 4 });
  const empty = await storage.upload('empty', bytes(''), 'empty.txt');
  assert.equal(empty.size, 0);
  assert.equal(empty.sha256, createHash('sha256').digest('hex'));
  const emptyRead = await read(storage, empty.id);
  assert.equal(emptyRead.length, 0);
  assert.equal(emptyRead.end, -1);
  assert.equal(emptyRead.bytes.length, 0);
  await assert.rejects(storage.openFile(empty.id, { start: 0 }), code('INVALID_RANGE'));
  const exact = await storage.upload('exact', Readable.from([Buffer.from('12'), Buffer.from('34')]), 'a.txt');
  assert.equal(exact.size, 4);
  await assert.rejects(storage.upload('retry', Readable.from([Buffer.from('1234'), Buffer.from('5')]), 'a.txt'), code('LIMIT_EXCEEDED'));
  const failed = await storage.lookupUpload('retry');
  assert.equal(failed.state, 'failed');
  if (failed.state !== 'failed') throw new Error('Expected failure record');
  assert.equal(failed.error.code, 'LIMIT_EXCEEDED');
  assert.deepEqual((await readdir(join(root, 'files', failed.fileId))).sort(), ['identity.json', 'state.json']);
  const retried = await storage.upload('retry', bytes('1234'), 'a.txt');
  assert.equal(retried.id, failed.fileId);
  assert.equal((await read(storage, retried.id)).bytes.toString(), '1234');
});

test('zero-byte configured storage accepts only empty originals and defaults are exactly 100 MiB', async t => {
  assert.equal(DEFAULT_MAX_BYTES, 104857600);
  const { storage } = await fixture(t, { maxBytes: 0 });
  assert.equal((await storage.upload('empty', bytes(''), 'file')).size, 0);
  await assert.rejects(storage.upload('one', bytes('x'), 'file'), code('LIMIT_EXCEEDED'));
});

test('capture follows permitted source symlinks outside the data root; first success remains immutable', async t => {
  const { parent, storage, reopen } = await fixture(t);
  const source = join(parent, 'source.txt');
  const link = join(parent, 'linked.txt');
  await writeFile(source, 'version one');
  await symlink(source, link);
  const first = await storage.capture('message-1', './linked.txt', link);
  assert.equal((await read(storage, first.id)).bytes.toString(), 'version one');
  await writeFile(source, 'version two');
  assert.deepEqual(await storage.capture('message-1', './linked.txt', join(parent, 'missing')), first);
  const second = await storage.capture('message-2', './linked.txt', link);
  assert.notEqual(second.id, first.id);
  assert.equal((await read(storage, second.id)).bytes.toString(), 'version two');
  await rm(source);
  await storage.close();
  const restarted = await reopen();
  assert.deepEqual(await restarted.capture('message-1', './linked.txt', link), first);
  assert.deepEqual(await restarted.lookupCapture('message-1', './linked.txt'), { state: 'ready', file: first });
  assert.deepEqual(await restarted.lookupCapture('old-message', './linked.txt'), { state: 'no-record' });
});

test('failed capture remains failed through duplicate deltas and restart, without reopening its source', async t => {
  const { parent, storage, reopen } = await fixture(t);
  const source = join(parent, 'late.txt');
  await assert.rejects(storage.capture('message', './late.txt', source), code('SOURCE_NOT_FOUND'));
  const firstFailure = await storage.lookupCapture('message', './late.txt');
  assert.equal(firstFailure.state, 'failed');
  await writeFile(source, 'created after the reference failed');
  await assert.rejects(storage.capture('message', './late.txt', source), code('SOURCE_NOT_FOUND'));
  await storage.close();
  const restarted = await reopen();
  assert.deepEqual(await restarted.lookupCapture('message', './late.txt'), firstFailure);
  await assert.rejects(restarted.capture('message', './late.txt', source), code('SOURCE_NOT_FOUND'));
  const fresh = await restarted.capture('new-message', './late.txt', source);
  assert.equal((await read(restarted, fresh.id)).bytes.toString(), 'created after the reference failed');
});

test('parallel duplicate captures share one operation, while independent messages retain independent files', async t => {
  const { parent, storage } = await fixture(t);
  const source = join(parent, 'source.bin');
  await writeFile(source, Buffer.alloc(256 * 1024, 7));
  const pending = storage.capture('one', './source.bin', source);
  assert.equal(storage.capture('one', './source.bin', source), pending);
  const first = await pending;
  const second = await storage.capture('two', './source.bin', source);
  assert.equal(first.sha256, second.sha256);
  assert.notEqual(first.id, second.id);
  assert.notEqual((await stat(first.path)).ino, (await stat(second.path)).ino);
});

test('source directories are rejected without copying or serving arbitrary paths', async t => {
  const { parent, storage } = await fixture(t);
  await assert.rejects(storage.capture('directory', './dir', parent), code('INVALID_SOURCE'));
  assert.throws(() => storage.capture('relative', './a', './a'), code('INVALID_INPUT'));
  await assert.rejects(storage.lookupFile('../../outside'), code('INVALID_INPUT'));
  await assert.rejects(storage.openFile(parent), code('INVALID_INPUT'));
  assert.deepEqual(await storage.lookupUpload('unknown'), { state: 'no-record' });
});

test('capture detects source modification during streaming and publishes no partial original', async t => {
  const { parent, root, storage } = await fixture(t);
  const source = join(parent, 'changing.bin');
  await writeFile(source, Buffer.alloc(8 * 1024 * 1024, 1));
  const promise = storage.capture('change', './changing.bin', source);
  const checked = assert.rejects(promise, code('SOURCE_CHANGED'));
  let payload: string | undefined;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const lookup = await storage.lookupCapture('change', './changing.bin');
    if (lookup.state === 'pending') {
      const path = join(root, 'files', lookup.fileId, 'attempt', 'payload', 'body');
      try {
        if ((await stat(path)).size > 0) { payload = path; break; }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(payload, 'copy entered its streaming phase');
  await writeFile(source, Buffer.alloc(8 * 1024 * 1024, 2));
  await checked;
  assert.equal((await storage.lookupCapture('change', './changing.bin')).state, 'failed');
});

test('pending is observable before commit, and abort clears only its owned staging', async t => {
  const { storage, root } = await fixture(t);
  const permanent = await storage.upload('kept', bytes('keep'), 'keep.txt');
  const controller = new AbortController();
  const input = new Readable({ read() {} });
  const promise = storage.upload('abort', input, 'abort.txt', undefined, controller.signal);
  const checked = assert.rejects(promise, code('ABORTED'));
  let pending = await storage.lookupUpload('abort');
  for (let tries = 0; tries < 100 && pending.state === 'no-record'; tries++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    pending = await storage.lookupUpload('abort');
  }
  assert.equal(pending.state, 'pending');
  if (pending.state !== 'pending') throw new Error('Expected pending');
  await assert.rejects(storage.openFile(pending.fileId), code('PENDING'));
  controller.abort();
  await checked;
  assert.equal(input.destroyed, true);
  assert.equal((await storage.lookupUpload('abort')).state, 'failed');
  assert.equal((await read(storage, permanent.id)).bytes.toString(), 'keep');
  assert.deepEqual((await readdir(join(root, 'files', pending.fileId))).sort(), ['identity.json', 'state.json']);
});

test('input errors are explicit, persist failure, and concurrent work has a fixed bound', async t => {
  const { storage } = await fixture(t, { maxConcurrent: 1 });
  const input = new Readable({ read() {} });
  const controller = new AbortController();
  const first = storage.upload('held', input, 'held.txt', undefined, controller.signal);
  const checked = assert.rejects(first, code('ABORTED'));
  await assert.rejects(storage.upload('busy', bytes('x'), 'x'), code('BUSY'));
  controller.abort();
  await checked;
  const broken = Readable.from((async function* () {
    yield Buffer.from('partial');
    throw new Error('synthetic transport interruption');
  })());
  await assert.rejects(storage.upload('broken', broken, 'x'), code('IO_ERROR'));
  assert.equal((await storage.lookupUpload('broken')).state, 'failed');
});

test('range reads are byte exact and reject malformed, empty, or excessive ranges', async t => {
  const { storage } = await fixture(t);
  const saved = await storage.upload('range', bytes('0123456789'), 'ten.txt');
  const partial = await read(storage, saved.id, { start: 2, end: 5 });
  assert.equal(partial.bytes.toString(), '2345');
  assert.equal(partial.length, 4);
  assert.equal((await read(storage, saved.id, { start: 8 })).bytes.toString(), '89');
  for (const range of [{ start: -1 }, { start: 10 }, { start: 0, end: 10 }, { start: 5, end: 2 }, { start: NaN }, { start: 0.5 }]) {
    await assert.rejects(storage.openFile(saved.id, range), code('INVALID_RANGE'));
  }
});

test('stored-body and directory replacement symlinks cannot redirect serving', async t => {
  const { parent, storage, root } = await fixture(t);
  const external = join(parent, 'outside.txt');
  await writeFile(external, 'bad!', { mode: 0o600 });
  const saved = await storage.upload('body-link', bytes('safe'), 'a.txt');
  await rm(saved.path);
  await symlink(external, saved.path);
  await assert.rejects(storage.openFile(saved.id));
  const second = await storage.upload('directory-link', bytes('safe'), 'b.txt');
  const slot = join(root, 'files', second.id);
  const moved = join(parent, 'moved');
  await rename(slot, moved);
  await symlink(moved, slot);
  await assert.rejects(storage.openFile(second.id));
  const third = await storage.upload('files-link', bytes('safe'), 'c.txt');
  const originalFiles = join(parent, 'original-files');
  await rename(join(root, 'files'), originalFiles);
  await symlink(parent, join(root, 'files'));
  assert.equal((await read(storage, third.id)).bytes.toString(), 'safe', 'pinned files fd still addresses the original tree');
});

test('missing and truncated stored originals fail without recapturing', async t => {
  const { parent, storage } = await fixture(t);
  const source = join(parent, 'source.txt');
  await writeFile(source, 'original');
  const saved = await storage.capture('saved', './source.txt', source);
  await writeFile(saved.path, 'short');
  await assert.rejects(storage.openFile(saved.id), code('CORRUPT'));
  await rm(saved.path);
  await assert.rejects(storage.openFile(saved.id));
  assert.equal(await readFile(source, 'utf8'), 'original');
  await assert.rejects(storage.capture('saved', './source.txt', source));
  await assert.rejects(storage.lookupFile(saved.id));
});

test('MIME comes from bytes, not supplied labels; HTML and SVG never receive active inline types', async t => {
  const { storage } = await fixture(t);
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const media = [
    { data: png, mime: 'image/png', extension: '.png' },
    { data: Buffer.from('ffd8ffe000104a464946000101', 'hex'), mime: 'image/jpeg', extension: '.jpg' },
    { data: Buffer.from('RIFF0000WAVEfmt '), mime: 'audio/wav', extension: '.wav' },
    { data: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom0000isommp42')]), mime: 'video/mp4', extension: '.mp4' },
  ];
  for (const [index, item] of media.entries()) {
    const saved = await storage.upload(`media-${index}`, bytes(item.data), 'misleading.html', 'text/html');
    assert.equal(saved.mime, item.mime);
    assert.equal(saved.inline, true);
    assert.ok(saved.path.endsWith(item.extension));
  }
  for (const [index, value] of ['<script>alert(1)</script>', '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'not an image'].entries()) {
    const saved = await storage.upload(`unsafe-${index}`, bytes(value), 'claimed.png', 'image/png');
    assert.equal(saved.mime, 'application/octet-stream');
    assert.equal(saved.inline, false);
  }
});

test('root validation rejects relative, symlinked, and nonprivate directories without chmodding them', async t => {
  const { parent } = await fixture(t);
  await assert.rejects(createFileStorage({ root: 'relative' }), code('INVALID_ROOT'));
  const shared = join(parent, 'shared');
  await mkdir(shared, { mode: 0o755 });
  await chmod(shared, 0o755);
  await assert.rejects(createFileStorage({ root: shared }), code('UNSAFE_STORAGE'));
  assert.equal((await stat(shared)).mode & 0o777, 0o755);
  const linked = join(parent, 'link');
  await symlink(shared, linked);
  await assert.rejects(createFileStorage({ root: linked }), code('INVALID_ROOT'));
  await assert.rejects(createFileStorage({ root: join(parent, 'invalid'), maxBytes: -1 }), code('INVALID_INPUT'));
});

test('persisted interrupted captures report a bounded error and cannot be restarted by duplicate references', async t => {
  const { parent, root, storage, reopen } = await fixture(t);
  const source = join(parent, 'missing.txt');
  await assert.rejects(storage.capture('interrupted', './missing.txt', source), code('SOURCE_NOT_FOUND'));
  const lookup = await storage.lookupCapture('interrupted', './missing.txt');
  if (lookup.state !== 'failed') throw new Error('Expected failure');
  await writeFile(join(root, 'files', lookup.fileId, 'state.json'), JSON.stringify({ state: 'pending' }), { mode: 0o600 });
  await writeFile(source, 'late bytes');
  await storage.close();
  const restarted = await reopen();
  const interrupted = await restarted.lookupCapture('interrupted', './missing.txt');
  assert.equal(interrupted.state, 'failed');
  if (interrupted.state !== 'failed') throw new Error('Expected interrupted failure');
  assert.equal(interrupted.error.code, 'INTERRUPTED');
  await assert.rejects(restarted.capture('interrupted', './missing.txt', source), code('INTERRUPTED'));
  await assert.rejects(restarted.openFile(interrupted.fileId), code('INTERRUPTED'));
  assert.deepEqual(await restarted.lookupCapture('interrupted', './missing.txt'), interrupted);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'files', lookup.fileId, 'state.json'), 'utf8')), { state: 'pending' });
  assert.deepEqual((await readdir(join(root, 'files', lookup.fileId))).sort(), ['identity.json', 'state.json']);
});

test('web byte streams are supported and close is idempotent', async t => {
  const { storage } = await fixture(t);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('web')); controller.close(); } });
  const saved = await storage.upload('web', stream, 'web.txt');
  assert.equal((await read(storage, saved.id)).bytes.toString(), 'web');
  await storage.close();
  await storage.close();
  await assert.rejects(storage.lookupFile(saved.id), code('CLOSED'));
});

test('aborting a stalled web upload cancels the reader and persists a failure', async t => {
  const { storage } = await fixture(t);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const abort = new AbortController();
  const pending = storage.upload('web-abort', stream, 'web.txt', undefined, abort.signal);
  const checked = assert.rejects(pending, code('ABORTED'));
  const deadline = Date.now() + 3000;
  while (!stream.locked && Date.now() < deadline) await delay(5);
  assert.equal(stream.locked, true, 'stream reader has begun waiting for bytes');
  abort.abort();
  await checked;
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
  assert.equal((await storage.lookupUpload('web-abort')).state, 'failed');
});

test('concurrent upload retries do not create an unbounded in-memory queue', async t => {
  const { storage } = await fixture(t);
  const abort = new AbortController();
  const pending = storage.upload('shared-operation', new Readable({ read() {} }), 'same.txt', undefined, abort.signal);
  const checked = assert.rejects(pending, code('ABORTED'));
  for (let i = 0; i < 20; i++) {
    await assert.rejects(storage.upload('shared-operation', bytes('ignored'), 'same.txt'), code('PENDING'));
  }
  abort.abort();
  await checked;
  const saved = await storage.upload('shared-operation', bytes('new explicit retry'), 'same.txt');
  assert.equal((await read(storage, saved.id)).bytes.toString(), 'new explicit retry');
});

test('separate storage instances cannot overwrite a pending operation or capture a replay', async t => {
  const { parent, root, storage, reopen } = await fixture(t);
  const peer = await reopen();
  const abort = new AbortController();
  const pending = storage.upload('cross-instance', new Readable({ read() {} }), 'same.txt', undefined, abort.signal);
  const checked = assert.rejects(pending, code('ABORTED'));
  let registered = false;
  for (let i = 0; i < 1000; i++) {
    const state = await peer.lookupUpload('cross-instance');
    if (state.state === 'pending') {
      try {
        await stat(join(root, 'files', state.fileId, 'attempt'));
        registered = true;
        break;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(registered, true);
  await assert.rejects(peer.upload('cross-instance', bytes('other'), 'same.txt'), code('PENDING'));
  abort.abort();
  await checked;
  const saved = await peer.upload('cross-instance', bytes('original'), 'same.txt');
  assert.deepEqual(await storage.upload('cross-instance', bytes('original'), 'same.txt'), saved);
  await assert.rejects(storage.upload('cross-instance', bytes('changed'), 'same.txt'), code('CONFLICT'));
  const source = join(parent, 'capture.bin');
  await writeFile(source, Buffer.alloc(128 * 1024, 2));
  const capture = await storage.capture('cross-message', './capture.bin', source);
  await rm(source);
  assert.deepEqual(await peer.capture('cross-message', './capture.bin', source), capture);
});

test('corrupted metadata and managed filenames cannot redirect reads outside the owned namespace', async t => {
  const { storage, parent } = await fixture(t);
  const external = join(parent, 'outside.txt');
  await writeFile(external, 'outside');
  const saved = await storage.upload('tampered', bytes('original'), 'a.txt');
  const metadataPath = join(dirname(saved.path), 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
  await writeFile(metadataPath, JSON.stringify({ ...metadata, body: external }));
  await assert.rejects(storage.openFile(saved.id), code('CORRUPT'));
  await writeFile(metadataPath, '{not-json}');
  await assert.rejects(storage.lookupFile(saved.id), code('CORRUPT'));
});

test('same-size writes invalidate the original on lookup, full/range read, retry, and restart', async t => {
  const { storage, reopen } = await fixture(t);
  const saved = await storage.upload('same-size', bytes('original'), 'a.txt');
  const disk = JSON.parse(await readFile(join(dirname(saved.path), 'metadata.json'), 'utf8')) as {
    version: number; bodyStamp: Record<string, string>;
  };
  assert.equal(disk.version, 2);
  const before = await stat(saved.path, { bigint: true });
  assert.deepEqual(disk.bodyStamp, {
    dev: String(before.dev), ino: String(before.ino), size: String(before.size),
    mtimeNs: String(before.mtimeNs), ctimeNs: String(before.ctimeNs),
  });
  assert.equal((await read(storage, saved.id, { start: 1, end: 3 })).bytes.toString(), 'rig');
  assert.equal((await storage.lookupFile(saved.id)).state, 'ready', 'ordinary read atime changes do not invalidate the stamp');
  await writeFile(saved.path, 'modified');
  assert.equal((await stat(saved.path)).size, saved.size);
  await assert.rejects(storage.lookupFile(saved.id), code('CORRUPT'));
  await assert.rejects(storage.openFile(saved.id), code('CORRUPT'));
  await assert.rejects(storage.openFile(saved.id, { start: 0, end: 1 }), code('CORRUPT'));
  await assert.rejects(storage.upload('same-size', bytes('original'), 'a.txt'), code('CORRUPT'));
  await storage.close();
  await assert.rejects((await reopen()).lookupUpload('same-size'), code('CORRUPT'));
});

test('replacement inodes and ctime-only changes cannot retain a ready immutable identity', async t => {
  const { storage } = await fixture(t);
  const replaced = await storage.upload('replaced-inode', bytes('same'), 'a.txt');
  await rename(replaced.path, `${replaced.path}.previous`);
  await writeFile(replaced.path, 'same', { mode: 0o600 });
  await assert.rejects(storage.openFile(replaced.id), code('CORRUPT'));
  const changed = await storage.upload('ctime-only', bytes('same'), 'b.txt');
  const before = await stat(changed.path, { bigint: true });
  await delay(2);
  await chmod(changed.path, 0o600);
  const after = await stat(changed.path, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  await assert.rejects(storage.lookupFile(changed.id), code('CORRUPT'));
});

test('pending ownership is checked per record, without a sweep or recapturing stale sources', async t => {
  const { parent, root, storage, reopen } = await fixture(t);
  const source = join(parent, 'not-yet-present.txt');
  await assert.rejects(storage.capture('owner', './source', source), code('SOURCE_NOT_FOUND'));
  const state = await storage.lookupCapture('owner', './source');
  if (state.state !== 'failed') throw new Error('Expected capture failure');
  const statePath = join(root, 'files', state.fileId, 'state.json');
  await writeFile(source, 'must not be recaptured');
  await writeFile(statePath, JSON.stringify({ state: 'pending', owner: { pid: process.pid, operation: randomUUID() } }));
  const restarted = await reopen();
  const interrupted = await restarted.lookupFile(state.fileId);
  assert.equal(interrupted.state, 'failed');
  if (interrupted.state !== 'failed') throw new Error('Expected interrupted capture');
  assert.equal(interrupted.error.code, 'INTERRUPTED');
  await assert.rejects(restarted.capture('owner', './source', source), code('INTERRUPTED'));
  const foreign = { state: 'pending', owner: { pid: process.pid + 1, operation: randomUUID() } };
  await writeFile(statePath, JSON.stringify(foreign));
  const unknown = await restarted.lookupFile(state.fileId);
  assert.equal(unknown.state, 'failed');
  if (unknown.state !== 'failed') throw new Error('Expected unknown capture');
  assert.equal(unknown.error.code, 'ACTIVITY_UNKNOWN');
  await assert.rejects(restarted.capture('owner', './source', source), code('ACTIVITY_UNKNOWN'));
  assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), foreign);
  assert.deepEqual((await readdir(join(root, 'files', state.fileId))).sort(), ['identity.json', 'state.json']);
});
