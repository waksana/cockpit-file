import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as filesystem } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import type { ModuleHostIntentBody, ModuleIntentInvocation } from '@waksana/cockpit-module-sdk/backend';
import { createFileStorage, FileStorageError, type PromptRecord } from './storage.ts';
import { promptMiddleware } from './prompt.ts';

async function fixture(t: TestContext, maxBytes = 1024 * 1024) {
  const root = await mkdtemp(fileURLToPath(new URL('../../node_modules/prompt-fixture-', import.meta.url)));
  const storage = await createFileStorage({ root: join(root, 'data'), maxBytes });
  const stopping = new AbortController();
  const run = promptMiddleware(storage, stopping.signal);
  t.after(async () => { await storage.close(); await rm(root, { recursive: true, force: true }); });
  const source = join(root, 'source.txt');
  await writeFile(source, 'original');
  const invocation = (attachments: ModuleHostIntentBody<'prompt'>['attachments'] = [{ type: 'file', path: source }]):
  ModuleIntentInvocation<'prompt'> => ({
    name: 'prompt', invocationId: randomUUID(), origin: 'module', signal: new AbortController().signal,
    body: { sessionId: 'synthetic-session', text: 'unchanged', mode: 'enqueue', attachments },
  });
  const journal = async (id: string): Promise<PromptRecord> => JSON.parse(await readFile(
    join(storage.root, `prompt-${createHash('sha256').update(id).digest('hex')}`, 'state.json'), 'utf8'));
  return { root, source, storage, run, invocation, journal, stopping };
}

test('copies native files once, preserves other attachments/text and journals the exact downstream receipt', async t => {
  const f = await fixture(t);
  const originalOpen = filesystem.open;
  let sourceOpens = 0, sourceReads = 0;
  filesystem.open = async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (args[0] === f.source) {
      sourceOpens++;
      const read = handle.read.bind(handle);
      handle.read = ((...args: Parameters<typeof handle.read>) => {
        sourceReads++;
        return read(...args);
      }) as typeof handle.read;
    }
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { filesystem.open = originalOpen; syncBuiltinESMExports(); });
  const other = [
    { type: 'directory' as const, path: '/synthetic/directory' },
    { type: 'selection' as const, filePath: '/synthetic/code.ts', displayName: 'selection', text: 'text' },
    { type: 'blob' as const, mimeType: 'text/plain', data: 'aGVsbG8=' },
  ];
  const invocation = f.invocation([{ type: 'file', path: f.source, displayName: 'custom' }, ...other]);
  let calls = 0;
  const receipt = { ok: true, queued: true, messageId: 'native-message' };
  await f.run(invocation, async patch => {
    calls++;
    assert.deepEqual(Object.keys(patch!), ['attachments']);
    assert.deepEqual(patch!.attachments!.slice(1), other);
    const file = patch!.attachments![0]!;
    assert.equal(file.type, 'file');
    if (file.type !== 'file') assert.fail();
    assert.notEqual(file.path, f.source);
    assert.equal(file.displayName, 'custom');
    assert.equal(await readFile(file.path, 'utf8'), 'original');
    assert.equal((await f.journal(invocation.invocationId)).state, 'sending_unknown');
    return receipt;
  });
  assert.equal(calls, 1);
  assert.equal(sourceOpens, 1);
  assert.equal(sourceReads, 2, 'one data read and EOF, no hash/sniff reread');
  assert.equal(await readFile(f.source, 'utf8'), 'original');
  assert.equal(invocation.body.attachments![0]!.type, 'file');
  const record = await f.journal(invocation.invocationId);
  assert.equal(record.state, 'returned');
  assert.deepEqual(record.receipt, receipt);
  await assert.rejects(f.run(invocation, async () => { assert.fail('No invocation replay'); }), /already recorded/);
});

test('Web managed originals take a stamp-validated, body-read-free fast path with no patch or journal', async t => {
  const f = await fixture(t);
  const file = await f.storage.upload('web-upload', (async function* () { yield Buffer.from('web'); })(), 'web.txt');
  const originalOpen = filesystem.open;
  let bodyReads = 0;
  filesystem.open = async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('/body.txt')) {
      handle.read = (() => { bodyReads++; assert.fail('No managed body scan'); }) as typeof handle.read;
    }
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => { filesystem.open = originalOpen; syncBuiltinESMExports(); });
  let calls = 0;
  await f.run(f.invocation([{ type: 'file', path: file.path, displayName: 'web.txt' }]), async patch => {
    assert.equal(patch, undefined);
    calls++;
    return { ok: true, queued: false, messageId: 'web-native-id' };
  });
  assert.equal(calls, 1);
  assert.equal(bodyReads, 0);
  assert.deepEqual((await readdir(f.storage.root)).sort(), ['files', 'staging']);
});

test('claimed managed paths never fall back to external import, including aliases and corrupt bodies', async t => {
  const f = await fixture(t);
  const file = await f.storage.upload('web', (async function* () { yield Buffer.from('web'); })(), 'web.txt');
  const alias = join(f.root, 'alias');
  await symlink(file.path, alias);
  const orphan = join(f.storage.root, 'files', `f_${'a'.repeat(64)}`, 'ready', 'body.txt');
  await mkdir(join(orphan, '..'), { recursive: true, mode: 0o700 });
  await writeFile(orphan, 'orphan', { mode: 0o600 });
  for (const path of [orphan, alias, file.path.replace('/ready/', '/ready/../ready/'),
    `${f.storage.root}/../source.txt`,
    join(f.storage.root, 'files', `f_${'b'.repeat(64)}`, 'ready', 'body')]) {
    await assert.rejects(f.run(f.invocation([{ type: 'file', path }]), async () => assert.fail('must not send')));
  }
  await writeFile(file.path, 'corrupt');
  await assert.rejects(f.run(f.invocation([{ type: 'file', path: file.path }]), async () => assert.fail()), /changed/);
  assert.equal((await readdir(f.storage.root)).some(name => name.startsWith('prompt-')), false);
});

test('preparation failures persist partial copies and never send or delete originals', async t => {
  const f = await fixture(t, 8);
  const large = join(f.root, 'large');
  await writeFile(large, '123456789');
  for (const path of [large, join(f.root, 'missing'), f.root]) {
    const invocation = f.invocation([{ type: 'file', path: f.source }, { type: 'file', path }]);
    await assert.rejects(f.run(invocation, async () => assert.fail('must not send')));
    const record = await f.journal(invocation.invocationId);
    assert.equal(record.state, 'not_sent');
    assert.ok(record.files[0]!.fileId);
    assert.equal((await f.storage.lookupFile(record.files[0]!.fileId!)).state, 'ready');
    assert.equal(await readFile(f.source, 'utf8'), 'original');
  }
});

test('downstream failure remains durably unknown without resend or deleting the possibly referenced copy', async t => {
  const f = await fixture(t);
  const invocation = f.invocation();
  let calls = 0;
  const unknown = new Error('native outcome unknown');
  await assert.rejects(f.run(invocation, async () => { calls++; throw unknown; }), error => error === unknown);
  const record = await f.journal(invocation.invocationId);
  assert.equal(record.state, 'sending_unknown');
  assert.equal(record.receipt, undefined);
  assert.equal((await f.storage.lookupFile(record.files[0]!.fileId!)).state, 'ready');
  assert.equal(calls, 1);
});

test('cancel after publication prevents next and retains copies; post-next persistence failure is not success', async t => {
  const f = await fixture(t);
  const recordPrompt = f.storage.recordPrompt.bind(f.storage);
  f.storage.recordPrompt = async (record, create) => {
    await recordPrompt(record, create);
    if (record.state === 'sending_unknown') f.stopping.abort();
  };
  const cancelled = f.invocation();
  await assert.rejects(f.run(cancelled, async () => assert.fail()), /cancelled/);
  assert.equal((await f.journal(cancelled.invocationId)).state, 'not_sent');
  const g = await fixture(t);
  const persist = g.storage.recordPrompt.bind(g.storage);
  g.storage.recordPrompt = async (record, create) => {
    if (record.state === 'returned') throw new FileStorageError('IO_ERROR', 'receipt persistence failed');
    await persist(record, create);
  };
  const sent = g.invocation();
  let calls = 0;
  await assert.rejects(g.run(sent, async () => { calls++; return { ok: true, queued: true, messageId: 'accepted' }; }), /persistence failed/);
  assert.equal(calls, 1);
  assert.equal((await g.journal(sent.invocationId)).state, 'sending_unknown');
});

test('concurrent prompts keep independent copies and non-file-only calls are untouched', async t => {
  const f = await fixture(t);
  const first = f.invocation(), second = f.invocation();
  await Promise.all([first, second].map(invocation => f.run(invocation, async () => ({ ok: true, queued: false }))));
  assert.notEqual((await f.journal(first.invocationId)).files[0]!.fileId,
    (await f.journal(second.invocationId)).files[0]!.fileId);
  await f.run(f.invocation([{ type: 'directory', path: '/native' }]), async patch => {
    assert.equal(patch, undefined);
    return { ok: true, queued: false };
  });
});

test('restart retains unknown-send records without reopening sources or replaying a prompt', async t => {
  const f = await fixture(t);
  const invocation = f.invocation();
  await assert.rejects(f.run(invocation, async () => { throw new Error('unknown'); }));
  const before = await f.journal(invocation.invocationId);
  await f.storage.close();
  await writeFile(f.source, 'changed after unknown send');
  const reopened = await createFileStorage({ root: f.storage.root });
  t.after(() => reopened.close());
  await assert.rejects(promptMiddleware(reopened, f.stopping.signal)(invocation, async () => assert.fail()), /already recorded/);
  assert.deepEqual(await f.journal(invocation.invocationId), before);
  const saved = await reopened.lookupFile(before.files[0]!.fileId!);
  assert.equal(saved.state, 'ready');
  if (saved.state === 'ready') assert.equal(await readFile(saved.file.path, 'utf8'), 'original');
});
