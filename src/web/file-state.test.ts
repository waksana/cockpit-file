import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComposerContext, DraftAttachment, ModuleDraft, ModuleDraftSnapshot } from '@cockpit/module-api';
import { FileProbes, formatBytes, previewKind, UploadStore } from './file-state.ts';
import type { ProbeClock } from './file-state.ts';

const apiBase = `/_modules/cockpit-file/${'b'.repeat(64)}/api`;
const prefix = '/data/files/';
const fileId = (name: string) => `f_${Buffer.from(name).toString('hex').padEnd(64, '0')}`;
const fileUrl = `${apiBase}/files/${fileId('abc')}/body.png`;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

class Draft implements ModuleDraft {
  readonly sessionId: string;
  snapshot: ModuleDraftSnapshot = { text: '', attachments: [], pending: false };
  listeners = new Set<() => void>();
  blocks = 0;
  releases = 0;
  appended: DraftAttachment[][] = [];

  constructor(id: string) { this.sessionId = id; }
  getSnapshot() { return this.snapshot; }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  appendAttachments(values: readonly DraftAttachment[]) {
    const replaced = new Set(values.map(item => item.id));
    assert.equal(replaced.size, values.length, 'incoming attachment IDs must be unique');
    assert.ok(values.every(item => typeof item.id === 'string' && item.id.length > 0));
    const attachments = [...this.snapshot.attachments.filter(item => !replaced.has(item.id)), ...values];
    if (attachments.length > 20) throw new Error('At most 20 attachments');
    this.appended.push([...values]);
    this.snapshot = { ...this.snapshot, attachments };
    this.emit();
  }
  removeAttachment(id: string) {
    this.snapshot = { ...this.snapshot, attachments: this.snapshot.attachments.filter(item => item.id !== id) };
    this.emit();
  }
  editText(text: string) { this.snapshot = { ...this.snapshot, text }; this.emit(); }
  setPending(pending: boolean) { this.snapshot = { ...this.snapshot, pending }; this.emit(); }
  block() {
    this.blocks++;
    this.emit();
    let active = true;
    return () => {
      assert.equal(active, true, 'a guard must be released exactly once');
      active = false;
      this.blocks--;
      this.releases++;
      this.emit();
    };
  }
  private emit() { for (const listener of this.listeners) listener(); }
}

function composer(draft: ModuleDraft, operation: ComposerContext['operation'] = 'prompt'): ComposerContext {
  return { draft, operation, disabled: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function uploaded(id: string, name = id): Response {
  return Response.json({
    fileId: fileId(id), url: `${apiBase}/files/${fileId(id)}/body.txt`,
    attachment: { type: 'file', path: `${prefix}${fileId(id)}/ready/body.txt`, displayName: name },
  });
}

function uploadHarness(extra: Partial<ConstructorParameters<typeof UploadStore>[0]> = {}) {
  const calls: { path: string; init?: RequestInit; response: ReturnType<typeof deferred<Response>> }[] = [];
  const errors: unknown[] = [];
  let operation = 0;
  const store = new UploadStore({
    request: (path, init) => {
      const response = deferred<Response>();
      calls.push({ path, init, response });
      return response.promise;
    },
    report: error => errors.push(error), apiBase, nativePathPrefix: prefix, operationId: () => `operation-${++operation}`,
    ...extra,
  });
  return { store, calls, errors };
}

test('ordered uploads hold the captured draft guard across unmount and session switching', async () => {
  const { store, calls } = uploadHarness();
  const a = new Draft('session-a');
  const b = new Draft('session-b');
  const unmount = store.subscribe(a, () => {});
  const first = new File(['first'], 'first.txt', { type: 'text/plain' });
  const second = new File(['second'], 'second.txt');
  store.receive([first, second], composer(a));
  assert.equal(a.blocks, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.init!.body, first);
  assert.equal(calls[0]!.init!.headers && new Headers(calls[0]!.init!.headers).get('content-type'), 'application/octet-stream');
  assert.equal(new Headers(calls[0]!.init!.headers).get('x-file-mime'), 'text/plain');
  unmount();
  const unmountB = store.subscribe(b, () => {});
  calls[1]!.response.resolve(uploaded('second'));
  await settle();
  assert.deepEqual(a.snapshot.attachments.map(item => item.value.displayName), ['second']);
  assert.deepEqual(store.snapshot(a).items.map(item => [item.id, item.status]), [['operation-1', 'uploading']]);
  assert.equal(a.blocks, 1);

  const refreshed = new Draft(a.sessionId);
  refreshed.snapshot = { ...refreshed.snapshot, attachments: JSON.parse(JSON.stringify(a.snapshot.attachments)) };
  const next = uploadHarness();
  next.store.subscribe(refreshed, () => {});
  assert.deepEqual(refreshed.snapshot.attachments.map(item => item.value.displayName), ['second']);
  assert.deepEqual(next.store.snapshot(refreshed), { items: [] });
  assert.equal(refreshed.blocks, 0);
  assert.equal(next.calls.length, 0);
  next.store.dispose();

  calls[0]!.response.resolve(uploaded('first'));
  await settle();
  assert.deepEqual(a.snapshot.attachments.map(item => item.value.displayName), ['first', 'second']);
  assert.equal(a.blocks, 0);
  assert.equal(b.snapshot.attachments.length, 0);
  assert.equal(b.blocks, 0);
  assert.equal(store.snapshot(a).items.length, 0);
  unmountB();
  store.dispose();
});

test('failed upload retains its File and operation ID for an explicit retry', async () => {
  const { store, calls, errors } = uploadHarness();
  const draft = new Draft('session');
  const file = new File(['bytes'], '雪 & ?.txt');
  store.receive([file], composer(draft));
  assert.match(calls[0]!.path, /^\/upload\?name=%E9%9B%AA%20%26%20%3F.txt&operationId=operation-1$/);
  calls[0]!.response.resolve(Response.json({ error: { message: 'Disk busy' } }, { status: 503 }));
  await settle();
  assert.match(store.snapshot(draft).items[0]!.error!, /Disk busy/);
  assert.equal(draft.blocks, 1);
  assert.equal(errors.length, 0, 'the file item owns its upload error, without a second global notification');
  store.retry(draft, 'operation-1');
  assert.equal(calls[1]!.path, calls[0]!.path);
  assert.equal(calls[1]!.init!.body, file);
  calls[1]!.response.resolve(uploaded('retried'));
  await settle();
  assert.equal(draft.blocks, 0);
  assert.equal(draft.snapshot.attachments.length, 1);
  store.dispose();
});

test('removing a failed first file unblocks its successor and discards only its upload operation', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a'), new File(['b'], 'b')], composer(draft));
  calls[1]!.response.resolve(uploaded('second'));
  calls[0]!.response.reject(new Error('Connection lost'));
  await settle();
  assert.equal(draft.blocks, 1);
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['second']);
  assert.deepEqual(store.snapshot(draft).items.map(item => item.status), ['failed']);
  const writes = draft.appended.length;
  store.remove(draft, 'operation-1');
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['second']);
  assert.equal(draft.appended.length, writes, 'removal must not re-append an already ready successor');
  assert.equal(draft.blocks, 0);
  assert.deepEqual(calls.map(call => call.init!.method), ['POST', 'POST', 'DELETE']);
  assert.equal(calls[2]!.path, '/uploads/operation-1');
  calls[2]!.response.resolve(new Response(null, { status: 204 }));
  store.dispose();
});

test('overlapping selections preserve selection order and share only their own draft guard', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a')], composer(draft));
  store.receive([new File(['b'], 'b'), new File(['c'], 'c')], composer(draft));
  store.receive([new File(['d'], 'd')], composer(draft));
  assert.equal(draft.blocks, 1);
  calls[3]!.response.resolve(uploaded('fourth'));
  await settle();
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['fourth']);
  calls[1]!.response.resolve(uploaded('second'));
  await settle();
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['second', 'fourth']);
  calls[2]!.response.resolve(uploaded('third'));
  await settle();
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['second', 'third', 'fourth']);
  calls[0]!.response.resolve(uploaded('first'));
  await settle();
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['first', 'second', 'third', 'fourth']);
  assert.equal(store.snapshot(draft).items.length, 0);
  assert.equal(draft.releases, 1);
  store.dispose();
});

test('removing an attached successor cannot resurrect it when earlier uploads or new selections complete', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a'), new File(['b'], 'b')], composer(draft));
  calls[1]!.response.resolve(uploaded('second'));
  await settle();
  draft.removeAttachment('cf-upload:operation-2');
  assert.equal(draft.snapshot.attachments.length, 0);
  assert.equal(draft.blocks, 1);
  store.receive([new File(['c'], 'c')], composer(draft));
  calls[2]!.response.resolve(uploaded('third'));
  await settle();
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['third']);
  calls[0]!.response.resolve(uploaded('first'));
  await settle();
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['first', 'third']);
  assert.equal(draft.blocks, 0);
  assert.ok(draft.appended.slice(1).every(values => values.every(item => item.id !== 'cf-upload:operation-2')));
  store.dispose();
});

test('reordering touches only later owned successes and keeps other drafts, modules and native send state intact', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  const other = new Draft('other-session');
  const foreign: DraftAttachment = { id: 'other-module', value: { type: 'file', path: '/synthetic/foreign' } };
  const releaseOtherModule = draft.block();
  store.receive([new File(['prefix'], 'prefix')], composer(draft));
  calls[0]!.response.resolve(uploaded('prefix'));
  await settle();
  draft.appendAttachments([foreign]);
  const append = draft.appendAttachments.bind(draft);
  draft.appendAttachments = values => {
    assert.ok(values.every(item => item.id !== foreign.id && item.id !== 'cf-upload:operation-1'));
    append(values);
  };
  draft.snapshot = { ...draft.snapshot, text: 'keep this draft text' };
  store.receive([new File(['a'], 'a'), new File(['b'], 'b')], composer(draft));
  draft.setPending(true);
  store.receive([new File(['other'], 'other')], composer(other));
  calls[2]!.response.resolve(uploaded('second'));
  await settle();
  assert.equal(other.blocks, 1);
  assert.equal(other.snapshot.attachments.length, 0);
  calls[1]!.response.resolve(uploaded('first'));
  await settle();
  assert.deepEqual(draft.snapshot.attachments.map(item => item.id), [
    'cf-upload:operation-1', foreign.id, 'cf-upload:operation-2', 'cf-upload:operation-3',
  ]);
  assert.equal(draft.snapshot.attachments[1], foreign);
  assert.equal(draft.snapshot.text, 'keep this draft text');
  assert.equal(draft.snapshot.pending, true);
  assert.equal(draft.blocks, 1, 'the other module still owns its blocker');
  assert.equal(other.blocks, 1);
  calls[3]!.response.resolve(uploaded('other'));
  await settle();
  assert.deepEqual(other.snapshot.attachments.map(item => item.value.displayName), ['other']);
  assert.equal(other.blocks, 0);
  releaseOtherModule();
  store.dispose();
});

test('active jobs keep their original draft handle when the same session is presented again', async () => {
  const { store, calls } = uploadHarness();
  const original = new Draft('session');
  const replacement = new Draft('session');
  store.receive([new File(['a'], 'a'), new File(['b'], 'b')], composer(original));
  store.subscribe(replacement, () => {});
  calls[1]!.response.resolve(uploaded('second'));
  await settle();
  calls[0]!.response.resolve(uploaded('first'));
  await settle();
  assert.deepEqual(original.snapshot.attachments.map(item => item.value.displayName), ['first', 'second']);
  assert.equal(original.blocks, 0);
  assert.deepEqual(replacement.snapshot.attachments, []);
  assert.equal(replacement.blocks, 0);
  store.dispose();
});

test('size limit failures remain explicit and blocked until removed', () => {
  const { store, calls } = uploadHarness({ maxBytes: 1 });
  const draft = new Draft('session');
  store.receive([new File(['too big'], 'large')], composer(draft));
  assert.equal(calls.length, 0);
  assert.equal(store.snapshot(draft).items[0]!.status, 'failed');
  assert.match(store.snapshot(draft).items[0]!.error!, /limit/);
  assert.equal(draft.blocks, 1);
  store.remove(draft, 'operation-1');
  assert.equal(draft.blocks, 0);
  store.dispose();
});

test('disabled, non-prompt and excessive batches do not start uploads', () => {
  const { store, calls, errors } = uploadHarness();
  const draft = new Draft('session');
  const files = [new File(['a'], 'a')];
  store.receive(files, { ...composer(draft), disabled: true });
  for (const operation of ['ask', 'plan', 'elicitation'] as const) store.receive(files, composer(draft, operation));
  store.receive(Array.from({ length: 21 }, () => files[0]!), composer(draft));
  assert.equal(calls.length, 0);
  assert.equal(draft.blocks, 0);
  assert.equal(errors.length, 5);
  assert.match(store.snapshot(draft).error!, /20 attachments/);
  store.dispose();
});

test('the 20-file limit counts each attached success once and reuses removed slots', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  const file = new File(['a'], 'a');
  store.receive([file, file], composer(draft));
  calls[1]!.response.resolve(uploaded('second'));
  await settle();
  store.receive(Array.from({ length: 18 }, () => file), composer(draft));
  assert.equal(calls.length, 20, 'a ready successor must not count as both pending and attached');
  store.receive([file], composer(draft));
  assert.equal(calls.length, 20);
  assert.match(store.snapshot(draft).error!, /20 attachments/);
  for (let index = 2; index < 20; index++) calls[index]!.response.resolve(uploaded(`file-${index}`));
  await settle();
  assert.equal(draft.snapshot.attachments.length, 19);
  assert.equal(store.snapshot(draft).items.length, 1);
  store.receive([file], composer(draft));
  assert.equal(calls.length, 20);
  draft.removeAttachment('cf-upload:operation-2');
  store.receive([file], composer(draft));
  assert.equal(calls.length, 21);
  calls[20]!.response.resolve(uploaded('replacement'));
  calls[0]!.response.resolve(uploaded('first'));
  await settle();
  assert.equal(draft.snapshot.attachments.length, 20);
  assert.equal(new Set(draft.snapshot.attachments.map(item => item.id)).size, 20);
  assert.equal(draft.snapshot.attachments[0]!.value.displayName, 'first');
  assert.equal(draft.snapshot.attachments.at(-1)!.value.displayName, 'replacement');
  assert.equal(draft.blocks, 0);
  assert.deepEqual(store.snapshot(draft), { items: [] });
  store.dispose();
});

test('remove and teardown abort work, suppress late callbacks and release guards once', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  let notifications = 0;
  store.subscribe(draft, () => notifications++);
  store.receive([new File(['a'], 'a')], composer(draft));
  store.remove(draft, 'operation-1');
  assert.equal(calls[0]!.init!.signal!.aborted, true);
  calls[0]!.response.resolve(uploaded('removed'));
  await settle();
  assert.equal(draft.appended.length, 0);
  store.receive([new File(['b'], 'b')], composer(draft));
  store.dispose();
  const before = notifications;
  assert.equal(calls[2]!.init!.signal!.aborted, true);
  calls[1]!.response.resolve(new Response(null, { status: 204 }));
  calls[2]!.response.resolve(uploaded('disposed'));
  await settle();
  assert.equal(notifications, before);
  assert.equal(draft.appended.length, 0);
  assert.equal(draft.blocks, 0);
  assert.equal(draft.releases, 2);
  store.dispose();
});

test('dispose preserves already attached successors and prevents late reordering or retry writes', async () => {
  const { store, calls, errors } = uploadHarness();
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a'), new File(['b'], 'b'), new File(['c'], 'c')], composer(draft));
  calls[1]!.response.resolve(uploaded('second'));
  calls[2]!.response.reject(new Error('Failed before disposal'));
  await settle();
  const writes = draft.appended.length;
  const reports = errors.length;
  store.dispose();
  calls[0]!.response.resolve(uploaded('first'));
  store.retry(draft, 'operation-3');
  store.remove(draft, 'operation-1');
  store.receive([new File(['late'], 'late')], composer(draft));
  await settle();
  assert.equal(calls.length, 3);
  assert.equal(draft.appended.length, writes);
  assert.equal(errors.length, reports);
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['second']);
  assert.equal(draft.blocks, 0);
  assert.equal(draft.releases, 1);
});

test('disposal during a host append cannot publish or release the same blocker again', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  let notifications = 0;
  store.subscribe(draft, () => notifications++);
  store.receive([new File(['a'], 'a')], composer(draft));
  const before = notifications;
  const append = draft.appendAttachments.bind(draft);
  draft.appendAttachments = values => { append(values); store.dispose(); };
  calls[0]!.response.resolve(uploaded('saved'));
  await settle();
  assert.equal(draft.snapshot.attachments.length, 1);
  assert.equal(draft.releases, 1);
  assert.equal(draft.blocks, 0);
  assert.equal(notifications, before);
});

test('refresh discards uploading and failed selections and restores only host draft attachments', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  draft.editText('host-owned text');
  store.receive([
    new File(['pending'], 'pending.txt'), new File(['failed'], 'failed.txt'), new File(['ready'], 'ready.txt'),
  ], composer(draft));
  calls[1]!.response.reject(new Error('Connection lost'));
  calls[2]!.response.resolve(uploaded('ready'));
  await settle();
  assert.deepEqual(store.snapshot(draft).items.map(item => item.status), ['uploading', 'failed']);
  assert.equal(draft.blocks, 1);
  const saved = JSON.parse(JSON.stringify({ text: draft.snapshot.text, attachments: draft.snapshot.attachments }));
  store.dispose();
  const next = uploadHarness();
  const refreshed = new Draft('session');
  refreshed.snapshot = { ...refreshed.snapshot, ...saved };
  const unmount = next.store.subscribe(refreshed, () => {});
  assert.equal(refreshed.blocks, 0);
  assert.deepEqual(next.store.snapshot(refreshed), { items: [] });
  assert.equal(refreshed.snapshot.text, 'host-owned text');
  assert.deepEqual(refreshed.snapshot.attachments.map(item => item.value.displayName), ['ready']);
  next.store.retry(refreshed, 'operation-1');
  next.store.retry(refreshed, 'operation-2');
  assert.equal(next.calls.length, 0);
  calls[0]!.response.resolve(uploaded('late'));
  await settle();
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['ready']);
  unmount();
  assert.equal(refreshed.blocks, 0);
  next.store.dispose();
});

test('invalid upload attachments fail explicitly instead of inserting unowned paths', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a')], composer(draft));
  calls[0]!.response.resolve(Response.json({
    fileId: fileId('abc'), url: fileUrl, attachment: { type: 'file', path: '/etc/passwd' },
  }));
  await settle();
  assert.match(store.snapshot(draft).items[0]!.error!, /managed native attachment/);
  assert.equal(draft.blocks, 1);
  assert.equal(draft.snapshot.attachments.length, 0);
  store.dispose();
});

test('upload URLs derive from the host API base instead of the deployment-relative response URL', async () => {
  const { store, calls } = uploadHarness({ apiBase: `https://host.test/cockpit${apiBase}` });
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a')], composer(draft));
  calls[0]!.response.resolve(Response.json({
    fileId: fileId('abc'), url: `${apiBase}/files/${fileId('abc')}/body.png`,
    attachment: { type: 'file', path: `${prefix}${fileId('abc')}/ready/body.png`, displayName: 'Uploaded file' },
  }));
  await settle();
  assert.equal(draft.snapshot.attachments.length, 1);
  assert.equal(draft.blocks, 0);
  store.dispose();
});

test('an in-progress upload receipt remains blocked and preserves the original operation for retry', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('pending-upload');
  store.receive([new File(['a'], 'a.txt')], composer(draft));
  calls[0]!.response.resolve(Response.json({ code: 'PENDING', error: 'Operation still in progress' }, { status: 202 }));
  await settle();
  assert.equal(draft.snapshot.attachments.length, 0);
  assert.equal(draft.blocks, 1);
  assert.match(store.snapshot(draft).items[0]!.error!, /still pending/);
  store.retry(draft, store.snapshot(draft).items[0]!.id);
  assert.equal(calls[0]!.path, calls[1]!.path);
  store.dispose();
});

test('draft append failures retain the saved result and can retry without uploading again', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  const append = draft.appendAttachments.bind(draft);
  draft.appendAttachments = () => { throw new Error('Draft temporarily unavailable'); };
  store.receive([new File(['a'], 'a')], composer(draft));
  calls[0]!.response.resolve(uploaded('saved'));
  await settle();
  assert.equal(store.snapshot(draft).items[0]!.status, 'failed');
  assert.match(store.snapshot(draft).items[0]!.error!, /Could not add uploaded files to the draft: Draft temporarily unavailable/);
  assert.equal(draft.blocks, 1);
  draft.appendAttachments = append;
  store.retry(draft, 'operation-1');
  assert.equal(calls.length, 1);
  assert.equal(draft.snapshot.attachments.length, 1);
  assert.equal(draft.blocks, 0);
  store.dispose();
});

test('failed draft additions do not stall later acknowledgements and retry restores selection order', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a'), new File(['b'], 'b')], composer(draft));
  const append = draft.appendAttachments.bind(draft);
  draft.appendAttachments = () => { throw new Error('Draft temporarily unavailable'); };
  calls[1]!.response.resolve(uploaded('second'));
  await settle();
  assert.equal(draft.snapshot.attachments.length, 0);
  assert.deepEqual(store.snapshot(draft).items.map(item => item.status), ['uploading', 'failed']);
  draft.appendAttachments = append;
  store.receive([new File(['c'], 'c')], composer(draft));
  calls[2]!.response.resolve(uploaded('third'));
  await settle();
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['third']);
  assert.equal(store.snapshot(draft).items[1]!.status, 'failed', 'draft-add failures require an explicit retry');
  calls[0]!.response.resolve(uploaded('first'));
  await settle();
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['first', 'third']);
  assert.deepEqual(store.snapshot(draft).items.map(item => item.id), ['operation-2']);
  assert.equal(draft.blocks, 1);
  store.retry(draft, 'operation-2');
  assert.equal(calls.length, 3, 'retry must reuse the saved native attachment, not upload bytes again');
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['first', 'second', 'third']);
  assert.deepEqual(draft.appended.at(-1)!.map(item => item.value.displayName), ['second', 'third']);
  assert.equal(draft.blocks, 0);
  store.dispose();
});

test('a failed reorder leaves existing successors ready and does not resurrect them if removed before retry', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a'), new File(['b'], 'b')], composer(draft));
  calls[1]!.response.resolve(uploaded('second'));
  await settle();
  const append = draft.appendAttachments.bind(draft);
  draft.appendAttachments = () => { throw new Error('Cannot update draft'); };
  calls[0]!.response.resolve(uploaded('first'));
  await settle();
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['second']);
  assert.deepEqual(store.snapshot(draft).items.map(item => [item.id, item.status]), [['operation-1', 'failed']]);
  draft.removeAttachment('cf-upload:operation-2');
  draft.appendAttachments = append;
  store.retry(draft, 'operation-1');
  assert.equal(calls.length, 2);
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['first']);
  assert.equal(draft.blocks, 0);
  store.dispose();
});

test('host capacity changes retain uploaded results until a draft slot is available', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a')], composer(draft));
  draft.appendAttachments(Array.from({ length: 20 }, (_, index) => ({
    id: `other-module-${index}`, value: { type: 'file', path: `/synthetic/${index}` },
  })));
  calls[0]!.response.resolve(uploaded('saved'));
  await settle();
  assert.equal(store.snapshot(draft).items[0]!.status, 'failed');
  assert.match(store.snapshot(draft).items[0]!.error!, /Could not add uploaded files/);
  assert.equal(draft.blocks, 1);
  draft.removeAttachment('other-module-0');
  store.retry(draft, 'operation-1');
  assert.equal(calls.length, 1);
  assert.equal(draft.snapshot.attachments.length, 20);
  assert.equal(draft.snapshot.attachments.at(-1)!.value.displayName, 'saved');
  assert.equal(draft.blocks, 0);
  store.dispose();
});

test('operation ID creation failures cannot leak an empty upload guard', () => {
  const { store, calls } = uploadHarness({ operationId: () => { throw new Error('Unavailable'); } });
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a')], composer(draft));
  assert.equal(draft.blocks, 0);
  assert.equal(calls.length, 0);
  assert.match(store.snapshot(draft).error!, /secure browser connection/);
  store.dispose();
});

test('ready discard eligibility outlives ordering entries without retaining browser Files', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  const file = new File(['synthetic'], 'duplicate.txt');
  store.receive([file, file], composer(draft));
  calls[0]!.response.resolve(uploaded('first'));
  calls[1]!.response.resolve(uploaded('second'));
  await settle();
  assert.equal(store.snapshot(draft).items.length, 0, 'successes were pruned from ordering entries');
  assert.equal(draft.listeners.size, 1, 'pending is still watched with no mounted view');
  assert.equal(draft.blocks, 0);
  store.removeAttachment(draft, 'cf-upload:operation-1');
  assert.deepEqual(draft.snapshot.attachments.map(item => item.id), ['cf-upload:operation-2']);
  assert.equal(calls[2]!.path, '/uploads/operation-1');
  assert.equal(calls[2]!.init!.method, 'DELETE');
  assert.equal(draft.blocks, 0, 'DELETE acknowledgement never blocks sending');
  store.removeAttachment(draft, 'cf-upload:operation-1');
  assert.equal(calls.length, 3, 'the same operation is discarded at most once');
  store.removeAttachment(draft, 'cf-upload:operation-2');
  assert.equal(calls[3]!.path, '/uploads/operation-2', 'identical selections are independent uploads');
  assert.equal(draft.listeners.size, 0, 'an empty scope stops watching the draft');
  for (const call of calls.slice(2)) call.response.resolve(new Response(null, { status: 204 }));
  await settle();
  store.dispose();
});

test('pending observed while the view is unmounted permanently protects prior owned uploads', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  const unmount = store.subscribe(draft, () => {});
  store.receive([new File(['a'], 'a')], composer(draft));
  calls[0]!.response.resolve(uploaded('first'));
  await settle();
  unmount();
  assert.equal(draft.listeners.size, 1);
  draft.setPending(true);
  draft.setPending(false);
  assert.equal(draft.listeners.size, 0);
  store.removeAttachment(draft, 'cf-upload:operation-1');
  assert.equal(calls.length, 1, 'an unconfirmed native submission must preserve the original');
  assert.equal(draft.snapshot.attachments.length, 0);
  store.receive([new File(['b'], 'b')], composer(draft));
  calls[1]!.response.resolve(uploaded('second'));
  await settle();
  store.removeAttachment(draft, 'cf-upload:operation-2');
  assert.equal(calls[2]!.path, '/uploads/operation-2', 'a future upload after pending ends is independently eligible');
  calls[2]!.response.resolve(new Response(null, { status: 204 }));
  store.dispose();
});

test('synchronous current pending checks protect removals even without a subscription notification', async () => {
  for (const complete of [false, true]) {
    const { store, calls } = uploadHarness();
    const draft = new Draft('session');
    store.receive([new File(['a'], 'a')], composer(draft));
    if (complete) { calls[0]!.response.resolve(uploaded('first')); await settle(); }
    draft.snapshot = { ...draft.snapshot, pending: true };
    if (complete) store.removeAttachment(draft, 'cf-upload:operation-1');
    else store.remove(draft, 'operation-1');
    assert.equal(calls.length, 1);
    assert.equal(draft.snapshot.pending, true, 'the module does not clear native pending or bypass sending');
    assert.equal(draft.blocks, complete ? 0 : 1);
    assert.equal(draft.snapshot.attachments.length, complete ? 1 : 0);
    assert.equal(calls[0]!.init!.signal!.aborted, false);
    store.dispose();
  }
});

test('new uploads and retries are rejected during native pending but work after its receipt', async () => {
  const { store, calls, errors } = uploadHarness();
  const draft = new Draft('session');
  const context = composer(draft);
  draft.setPending(true);
  store.receive([new File(['a'], 'a')], context);
  assert.equal(calls.length, 0, 'a stale picker/clipboard/drop context cannot start an upload');
  assert.equal(draft.blocks, 0);
  assert.match(store.snapshot(draft).error!, /正在提交/);
  draft.setPending(false);
  store.receive([new File(['a'], 'a')], context);
  calls[0]!.response.resolve(Response.json({ error: 'fixture failure' }, { status: 503 }));
  await settle();
  draft.setPending(true);
  store.retry(draft, 'operation-1');
  assert.equal(calls.length, 1);
  assert.equal(store.snapshot(draft).items[0]!.status, 'failed');
  draft.setPending(false);
  store.retry(draft, 'operation-1');
  assert.equal(calls.length, 2);
  assert.equal(errors.length, 2);
  store.dispose();
});

test('unfinished uploads crossing a native submission still permanently lose deletion eligibility', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a'), new File(['b'], 'b')], composer(draft));
  draft.setPending(true);
  draft.setPending(false);
  calls[0]!.response.resolve(uploaded('first'));
  await settle();
  store.removeAttachment(draft, 'cf-upload:operation-1');
  store.remove(draft, 'operation-2');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.init!.signal!.aborted, true);
  calls[1]!.response.resolve(uploaded('late'));
  await settle();
  assert.equal(draft.snapshot.attachments.length, 0);
  assert.equal(draft.blocks, 0);
  store.dispose();
});

test('restored, foreign, capture and replaced attachment identities never authorize a DELETE', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  draft.appendAttachments([
    { id: 'cf-upload:operation-123', value: { type: 'file', path: `${prefix}${fileId('restored')}/ready/body.txt` } },
    { id: fileId('capture'), value: { type: 'file', path: `${prefix}${fileId('capture')}/ready/body.txt` } },
    { id: 'native', value: { type: 'file', path: '/synthetic/native.txt' } },
  ]);
  for (const item of [...draft.snapshot.attachments]) store.removeAttachment(draft, item.id);
  assert.equal(calls.length, 0);
  store.receive([new File(['a'], 'a')], composer(draft));
  calls[0]!.response.resolve(uploaded('first'));
  await settle();
  draft.appendAttachments([{ id: 'cf-upload:operation-1', value: { type: 'file', path: '/synthetic/replacement' } }]);
  store.removeAttachment(draft, 'cf-upload:operation-1');
  assert.equal(calls.length, 1);
  store.dispose();
});

test('another draft handle cannot inherit this activation’s removal eligibility', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a')], composer(draft));
  calls[0]!.response.resolve(uploaded('first'));
  await settle();
  const restored = new Draft('session');
  restored.snapshot = structuredClone(draft.snapshot);
  store.removeAttachment(restored, 'cf-upload:operation-1');
  assert.equal(calls.length, 1);
  assert.equal(draft.snapshot.attachments.length, 1);
  draft.setPending(true);
  draft.setPending(false);
  store.removeAttachment(draft, 'cf-upload:operation-1');
  assert.equal(calls.length, 1, 'the original subscription was not redirected to the restored handle');
  store.dispose();
});

test('uncertain, failed and not-yet-acknowledged uploads are discarded once without awaiting DELETE', async () => {
  for (const status of [undefined, 202, 503]) {
    const { store, calls } = uploadHarness();
    const draft = new Draft('session');
    store.receive([new File(['a'], 'a')], composer(draft));
    if (status !== undefined) {
      calls[0]!.response.resolve(Response.json({ error: 'Commit not confirmed' }, { status }));
      await settle();
    }
    store.remove(draft, 'operation-1');
    assert.equal(store.snapshot(draft).items.length, 0);
    assert.equal(draft.blocks, 0);
    assert.equal(calls[1]!.path, '/uploads/operation-1');
    assert.equal(calls[1]!.init!.method, 'DELETE');
    store.remove(draft, 'operation-1');
    store.retry(draft, 'operation-1');
    assert.equal(calls.length, 2);
    calls[0]!.response.resolve(uploaded('late'));
    calls[1]!.response.resolve(new Response(null, { status: 204 }));
    await settle();
    assert.equal(draft.snapshot.attachments.length, 0);
    store.dispose();
  }
});

test('DELETE rejection and every non-204 response report failure without undoing removal', async () => {
  for (const status of [undefined, 200, 202, 403, 500]) {
    const { store, calls, errors } = uploadHarness();
    const draft = new Draft('session');
    store.receive([new File(['a'], 'a')], composer(draft));
    calls[0]!.response.resolve(uploaded('first'));
    await settle();
    store.removeAttachment(draft, 'cf-upload:operation-1');
    if (status === undefined) calls[1]!.response.reject(new Error('Delete connection lost'));
    else calls[1]!.response.resolve(new Response(null, { status }));
    await settle();
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), status === undefined ? /connection lost/ : new RegExp(`HTTP ${status}`));
    assert.equal(draft.snapshot.attachments.length, 0);
    assert.equal(draft.blocks, 0);
    store.dispose();
  }
});

test('host removal errors preserve an eligible original and are reported without DELETE', async () => {
  const { store, calls, errors } = uploadHarness();
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a')], composer(draft));
  calls[0]!.response.resolve(uploaded('first'));
  await settle();
  draft.removeAttachment = () => { throw new Error('Draft removal rejected'); };
  store.removeAttachment(draft, 'cf-upload:operation-1');
  assert.equal(calls.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(draft.snapshot.attachments.length, 1);
  store.dispose();
});

test('only unresolved jobs retain Files; eligibility stays bounded and never deletes on dispose or ACK', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  const internals = store as unknown as {
    scopes: Map<string, { entries: { file?: File }[]; owned: Map<string, unknown>; snapshot: { items: { file?: File }[] } }>;
  };
  for (let index = 0; index < 25; index++) {
    const start = calls.length;
    store.receive([new File(['a'], 'a')], composer(draft));
    calls[start]!.response.resolve(uploaded(`file-${index}`));
    await settle();
    const scope = internals.scopes.get(draft.sessionId)!;
    assert.equal(scope.owned.size, 1);
    assert.equal(scope.entries.length, 0);
    assert.equal(scope.snapshot.items.length, 0);
    draft.setPending(true);
    draft.removeAttachment(`cf-upload:operation-${index + 1}`);
    draft.setPending(false);
    assert.equal(scope.owned.size, 0);
    assert.equal(draft.listeners.size, 0);
  }
  const start = calls.length;
  draft.appendAttachments = () => { throw new Error('Append failed'); };
  store.receive([new File(['b'], 'b')], composer(draft));
  calls[start]!.response.resolve(uploaded('saved'));
  await settle();
  const scope = internals.scopes.get(draft.sessionId)!;
  assert.ok(scope.entries.every(entry => !entry.file));
  assert.ok(scope.snapshot.items.every(entry => !entry.file), 'successful upload bytes are not kept for append retry');
  store.dispose();
  assert.equal(scope.owned.size, 0);
  assert.equal(scope.entries.length, 0);
  assert.equal(scope.snapshot.items.length, 0);
  assert.equal(draft.listeners.size, 0);
  assert.ok(calls.every(call => call.init!.method === 'POST'), 'ACK and module teardown do not delete originals');
});

class Clock implements ProbeClock {
  time = 0;
  serial = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  now() { return this.time; }
  setTimeout(callback: () => void, delay: number) {
    const id = ++this.serial;
    this.tasks.set(id, { at: this.time + delay, callback });
    return id;
  }
  clearTimeout(handle: unknown) { this.tasks.delete(handle as number); }
  async advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const task = [...this.tasks].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!task) break;
      this.tasks.delete(task[0]);
      this.time = task[1].at;
      task[1].callback();
      await settle();
    }
    this.time = end;
    await settle();
  }
}

test('HEAD probes coalesce by URL and stop after a single five-second budget', async () => {
  const clock = new Clock();
  const calls: { time: number; path: string; init?: RequestInit }[] = [];
  const probes = new FileProbes(async (path, init) => {
    calls.push({ time: clock.time, path, init });
    const pending = calls.length % 2 === 1;
    return new Response(null, {
      status: pending ? 202 : 404,
      headers: { 'X-File-State': pending ? 'pending' : 'missing' },
    });
  }, apiBase, clock);
  const offA = probes.subscribe(fileUrl, () => {});
  const offB = probes.subscribe(fileUrl, () => {});
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, `/files/${fileId('abc')}/body.png`);
  assert.equal(calls[0]!.init!.method, 'HEAD');
  assert.equal(calls[0]!.init!.cache, 'no-store');
  await clock.advance(4_999);
  assert.equal(probes.snapshot(fileUrl).status, 'pending');
  assert.equal(probes.snapshot(fileUrl).failure, undefined);
  assert.equal(probes.snapshot(fileUrl).error, undefined);
  await clock.advance(1);
  assert.equal(probes.snapshot(fileUrl).status, 'unavailable');
  assert.equal(probes.snapshot(fileUrl).deadline, 5_000);
  assert.deepEqual(probes.snapshot(fileUrl).failure, { kind: 'timeout' });
  assert.equal(probes.snapshot(fileUrl).error,
    'File status check did not finish within five seconds. File availability is still unknown; retry to check again.');
  assert.ok(calls.length <= 9);
  assert.equal(clock.tasks.size, 0);
  const count = calls.length;
  offA(); offB();
  const offC = probes.subscribe(fileUrl, () => {});
  await clock.advance(5_000);
  assert.equal(calls.length, count, 'remount cannot start a new round');
  probes.retry(fileUrl);
  assert.equal(probes.snapshot(fileUrl).failure, undefined);
  assert.equal(probes.snapshot(fileUrl).error, undefined);
  await settle();
  assert.equal(calls.length, count + 1);
  assert.equal(probes.snapshot(fileUrl).deadline, 15_000);
  assert.ok(calls.every(call => call.init?.method === 'HEAD' && call.init.body === undefined),
    'status checks never fetch file bytes or trigger capture');
  offC();
  probes.dispose();
});

test('hidden and unmounted probes abort and resume against their original deadline', async () => {
  const clock = new Clock();
  const calls: AbortSignal[] = [];
  const probes = new FileProbes((_path, init) => {
    calls.push(init!.signal as AbortSignal);
    return new Promise(() => {});
  }, apiBase, clock);
  const off = probes.subscribe(fileUrl, () => {});
  await clock.advance(1_000);
  probes.setVisible(false);
  assert.equal(calls[0]!.aborted, true);
  assert.equal(clock.tasks.size, 0);
  await clock.advance(5_000);
  probes.setVisible(true);
  assert.equal(probes.snapshot(fileUrl).status, 'unavailable');
  assert.deepEqual(probes.snapshot(fileUrl).failure, { kind: 'timeout' });
  assert.equal(calls.length, 1);
  off();
  probes.retry(fileUrl);
  assert.equal(probes.snapshot(fileUrl).failure, undefined);
  assert.equal(probes.snapshot(fileUrl).error, undefined);
  assert.equal(calls.length, 1, 'manual retry without a consumer cannot start polling');
  const remount = probes.subscribe(fileUrl, () => {});
  assert.equal(calls.length, 2);
  remount();
  assert.equal(calls[1]!.aborted, true);
  assert.equal(clock.tasks.size, 0);
  probes.dispose();
});

test('hung requests abort at the total deadline and late success cannot change the timeout', async () => {
  const clock = new Clock();
  const response = deferred<Response>();
  let signal: AbortSignal | undefined;
  const probes = new FileProbes((_path, init) => {
    signal = init!.signal as AbortSignal;
    return response.promise;
  }, apiBase, clock);
  probes.subscribe(fileUrl, () => {});
  await clock.advance(5_000);
  assert.equal(signal!.aborted, true);
  assert.equal(probes.snapshot(fileUrl).status, 'unavailable');
  assert.deepEqual(probes.snapshot(fileUrl).failure, { kind: 'timeout' });
  assert.equal(clock.tasks.size, 0);
  const snapshot = probes.snapshot(fileUrl);
  response.resolve(new Response(null, { headers: { 'content-type': 'image/png' } }));
  await settle();
  assert.equal(probes.snapshot(fileUrl), snapshot);
  probes.dispose();
});

test('HTTP errors fail fast with their status, without inferring file absence, and reset on retry', async () => {
  for (const status of [401, 403, 410, 422, 500, 503]) {
    const clock = new Clock();
    let requests = 0;
    const probes = new FileProbes(async () => {
      requests++;
      return new Response(null, { status: requests === 1 ? status : 200 });
    }, apiBase, clock);
    probes.subscribe(fileUrl, () => {});
    await settle();
    assert.equal(probes.snapshot(fileUrl).status, 'unavailable', String(status));
    assert.deepEqual(probes.snapshot(fileUrl).failure, { kind: 'http', status });
    assert.equal(probes.snapshot(fileUrl).error, status === 401 || status === 403
      ? 'You do not have access to this file.'
      : `File status check failed (HTTP ${status}).`);
    assert.equal(clock.tasks.size, 0);
    await clock.advance(5_000);
    assert.equal(requests, 1);
    assert.deepEqual(probes.snapshot(fileUrl).failure, { kind: 'http', status }, 'HTTP failures do not become timeouts');
    probes.retry(fileUrl);
    assert.equal(probes.snapshot(fileUrl).status, 'pending');
    assert.equal(probes.snapshot(fileUrl).failure, undefined);
    assert.equal(probes.snapshot(fileUrl).error, undefined);
    await settle();
    assert.equal(requests, 2);
    assert.equal(probes.snapshot(fileUrl).status, 'ready');
    assert.equal(probes.snapshot(fileUrl).failure, undefined);
    assert.equal(probes.snapshot(fileUrl).error, undefined);
    assert.equal(clock.tasks.size, 0);
    probes.dispose();
  }
});

test('X-File-State failed makes otherwise retryable HTTP statuses fail immediately', async () => {
  for (const status of [202, 404]) {
    const clock = new Clock();
    let requests = 0;
    const probes = new FileProbes(async () => {
      requests++;
      return new Response(null, { status, headers: { 'X-File-State': 'failed' } });
    }, apiBase, clock);
    probes.subscribe(fileUrl, () => {});
    await settle();
    assert.equal(probes.snapshot(fileUrl).status, 'unavailable');
    assert.deepEqual(probes.snapshot(fileUrl).failure, { kind: 'http', status });
    assert.equal(probes.snapshot(fileUrl).error, `File status check failed (HTTP ${status}).`);
    assert.equal(clock.tasks.size, 0);
    await clock.advance(5_000);
    assert.equal(requests, 1);
    probes.dispose();
  }
});

test('network errors preserve full details and require explicit retry to clear their failure', async () => {
  const clock = new Clock();
  const detail = `Connection lost: ${'diagnostic detail '.repeat(40)}`;
  let requests = 0;
  const probes = new FileProbes(async () => {
    if (++requests === 1) throw new Error(detail);
    return new Response(null);
  }, apiBase, clock);
  const off = probes.subscribe(fileUrl, () => {});
  await settle();
  assert.equal(probes.snapshot(fileUrl).status, 'unavailable');
  assert.deepEqual(probes.snapshot(fileUrl).failure, { kind: 'network' });
  assert.equal(probes.snapshot(fileUrl).error, `File status check failed: ${detail}`);
  assert.equal(clock.tasks.size, 0);
  off();
  probes.subscribe(fileUrl, () => {});
  await clock.advance(10_000);
  assert.equal(requests, 1);
  assert.deepEqual(probes.snapshot(fileUrl).failure, { kind: 'network' });
  probes.retry(fileUrl);
  assert.equal(probes.snapshot(fileUrl).status, 'pending');
  assert.equal(probes.snapshot(fileUrl).failure, undefined);
  assert.equal(probes.snapshot(fileUrl).error, undefined);
  await settle();
  assert.equal(requests, 2);
  assert.deepEqual(probes.snapshot(fileUrl), {
    status: 'ready', round: 1, deadline: 15_000, mime: 'application/octet-stream',
  });
  assert.equal(clock.tasks.size, 0);
  probes.dispose();
});

test('HEAD 200 finishes media and ordinary metadata checks without reading bodies or waiting for preview events', async () => {
  for (const mime of ['image/png', 'video/mp4', 'audio/mpeg', 'application/pdf']) {
    const clock = new Clock();
    const response = deferred<Response>();
    const calls: RequestInit[] = [];
    const probes = new FileProbes((_path, init) => {
      calls.push(init!);
      return response.promise;
    }, apiBase, clock);
    probes.subscribe(fileUrl, () => {});
    probes.subscribe(fileUrl, () => {});
    assert.equal(calls.length, 1);
    assert.equal(clock.tasks.size, 1);
    await clock.advance(4_999);
    const metadata = new Response('The probe must not read these bytes.', {
      headers: { 'content-type': `${mime}; charset=binary`, 'content-length': '2048' },
    });
    response.resolve(metadata);
    await settle();
    const snapshot = probes.snapshot(fileUrl);
    assert.deepEqual(snapshot, {
      status: 'ready', round: 0, deadline: 5_000, mime, size: 2048,
    });
    assert.equal(clock.tasks.size, 0, 'HEAD success clears the deadline even for previewable MIME types');
    await clock.advance(10_000);
    assert.equal(probes.snapshot(fileUrl), snapshot, 'ready metadata remains stable without media events');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'HEAD');
    assert.equal(calls[0]!.body, undefined);
    assert.equal(metadata.bodyUsed, false);
    probes.dispose();
  }
});

test('preview MIME and size formatting helpers remain available to the UI', () => {
  assert.equal(previewKind('image/png'), 'image');
  assert.equal(previewKind('video/mp4'), 'video');
  assert.equal(previewKind('audio/mpeg'), 'audio');
  assert.equal(previewKind('text/html'), null);
  assert.equal(formatBytes(1_048_576), '1.0 MiB');
});

test('ready metadata survives hiding and remounting beyond the HEAD deadline without another request', async () => {
  const clock = new Clock();
  let requests = 0;
  const probes = new FileProbes(async () => {
    requests++;
    return new Response(null, { headers: { 'content-type': 'video/mp4' } });
  }, apiBase, clock);
  const off = probes.subscribe(fileUrl, () => {});
  await settle();
  const snapshot = probes.snapshot(fileUrl);
  assert.equal(snapshot.status, 'ready');
  probes.setVisible(false);
  off();
  await clock.advance(5_001);
  probes.setVisible(true);
  probes.subscribe(fileUrl, () => {});
  await clock.advance(10_000);
  assert.equal(probes.snapshot(fileUrl), snapshot);
  assert.equal(requests, 1);
  assert.equal(clock.tasks.size, 0);
  probes.dispose();
});

test('unsubscribing one shared consumer leaves the other consumer HEAD request active', async () => {
  const clock = new Clock();
  const response = deferred<Response>();
  const signals: AbortSignal[] = [];
  let notificationsA = 0;
  let notificationsB = 0;
  const probes = new FileProbes((_path, init) => {
    signals.push(init!.signal as AbortSignal);
    return response.promise;
  }, apiBase, clock);
  const offA = probes.subscribe(fileUrl, () => notificationsA++);
  probes.subscribe(fileUrl, () => notificationsB++);
  offA();
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.aborted, false);
  response.resolve(new Response(null));
  await settle();
  assert.equal(notificationsA, 0);
  assert.equal(notificationsB, 1);
  assert.equal(probes.snapshot(fileUrl).status, 'ready');
  assert.equal(clock.tasks.size, 0);
  probes.dispose();
});

test('late aborted results cannot overwrite a resumed or explicitly retried HEAD check', async () => {
  for (const action of ['hide', 'unmount', 'retry']) {
    for (const result of ['success', 'error']) {
      const clock = new Clock();
      const calls: { signal: AbortSignal; response: ReturnType<typeof deferred<Response>> }[] = [];
      const probes = new FileProbes((_path, init) => {
        const response = deferred<Response>();
        calls.push({ signal: init!.signal as AbortSignal, response });
        return response.promise;
      }, apiBase, clock);
      const off = probes.subscribe(fileUrl, () => {});
      await clock.advance(1_000);
      if (action === 'hide') {
        probes.setVisible(false);
        probes.setVisible(true);
      } else if (action === 'unmount') {
        off();
        probes.subscribe(fileUrl, () => {});
      } else {
        probes.retry(fileUrl);
      }
      assert.equal(calls.length, 2);
      assert.equal(calls[0]!.signal.aborted, true);
      const snapshot = probes.snapshot(fileUrl);
      assert.deepEqual(snapshot, {
        status: 'pending', round: action === 'retry' ? 1 : 0, deadline: action === 'retry' ? 6_000 : 5_000,
      });
      if (result === 'success') {
        calls[0]!.response.resolve(new Response(null, { headers: { 'content-type': 'image/png' } }));
      } else {
        calls[0]!.response.reject(new Error('Stale network error'));
      }
      await settle();
      assert.equal(probes.snapshot(fileUrl), snapshot);
      assert.equal(calls[1]!.signal.aborted, false);
      calls[1]!.response.resolve(new Response(null, { headers: { 'content-type': 'text/plain' } }));
      await settle();
      assert.deepEqual(probes.snapshot(fileUrl), { ...snapshot, status: 'ready', mime: 'text/plain' });
      assert.equal(clock.tasks.size, 0);
      await clock.advance(10_000);
      assert.equal(calls.length, 2);
      probes.dispose();
    }
  }
});

test('a HEAD success at the deadline is a timeout even before the timer callback runs', async () => {
  const clock = new Clock();
  const response = deferred<Response>();
  const probes = new FileProbes(() => response.promise, apiBase, clock);
  probes.subscribe(fileUrl, () => {});
  clock.time = 5_000;
  response.resolve(new Response(null));
  await settle();
  assert.equal(probes.snapshot(fileUrl).status, 'unavailable');
  assert.deepEqual(probes.snapshot(fileUrl).failure, { kind: 'timeout' });
  assert.equal(clock.tasks.size, 0);
  probes.dispose();
});

test('disposed probes abort and ignore in-flight callbacks', async () => {
  const clock = new Clock();
  const response = deferred<Response>();
  let notifications = 0;
  let signal: AbortSignal | undefined;
  const probes = new FileProbes((_path, init) => {
    signal = init!.signal as AbortSignal;
    return response.promise;
  }, apiBase, clock);
  probes.subscribe(fileUrl, () => notifications++);
  probes.dispose();
  response.resolve(new Response(null));
  await settle();
  assert.equal(notifications, 0);
  assert.equal(signal!.aborted, true);
  assert.equal(clock.tasks.size, 0);
});
