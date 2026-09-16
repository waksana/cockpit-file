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
    this.appended.push([...values]);
    this.snapshot = { ...this.snapshot, attachments: [...this.snapshot.attachments, ...values] };
    this.emit();
  }
  removeAttachment(id: string) {
    this.snapshot = { ...this.snapshot, attachments: this.snapshot.attachments.filter(item => item.id !== id) };
    this.emit();
  }
  editText(text: string) { this.snapshot = { ...this.snapshot, text }; this.emit(); }
  block() {
    this.blocks++;
    this.snapshot = { ...this.snapshot, pending: true };
    this.emit();
    let active = true;
    return () => {
      assert.equal(active, true, 'a guard must be released exactly once');
      active = false;
      this.blocks--;
      this.releases++;
      this.snapshot = { ...this.snapshot, pending: this.blocks > 0 };
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
  assert.equal(a.appended.length, 0);
  assert.equal(store.snapshot(a).items[1]!.status, 'ready');
  assert.equal(a.blocks, 1);
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
  assert.equal(errors.length, 1);
  store.retry(draft, 'operation-1');
  assert.equal(calls[1]!.path, calls[0]!.path);
  assert.equal(calls[1]!.init!.body, file);
  calls[1]!.response.resolve(uploaded('retried'));
  await settle();
  assert.equal(draft.blocks, 0);
  assert.equal(draft.snapshot.attachments.length, 1);
  store.dispose();
});

test('removing a failed first file releases later ready files in batch order without DELETE', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a'), new File(['b'], 'b')], composer(draft));
  calls[1]!.response.resolve(uploaded('second'));
  calls[0]!.response.reject(new Error('Connection lost'));
  await settle();
  assert.equal(draft.blocks, 1);
  store.remove(draft, 'operation-1');
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['second']);
  assert.equal(draft.blocks, 0);
  assert.deepEqual(calls.map(call => call.init!.method), ['POST', 'POST']);
  store.dispose();
});

test('overlapping selections preserve selection order and share only their own draft guard', async () => {
  const { store, calls } = uploadHarness();
  const draft = new Draft('session');
  store.receive([new File(['a'], 'a')], composer(draft));
  store.receive([new File(['b'], 'b')], composer(draft));
  assert.equal(draft.blocks, 1);
  calls[1]!.response.resolve(uploaded('second'));
  await settle();
  assert.equal(draft.snapshot.attachments.length, 0);
  calls[0]!.response.resolve(uploaded('first'));
  await settle();
  assert.deepEqual(draft.snapshot.attachments.map(item => item.value.displayName), ['first', 'second']);
  assert.equal(draft.releases, 1);
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
  assert.equal(calls[1]!.init!.signal!.aborted, true);
  calls[1]!.response.resolve(uploaded('disposed'));
  await settle();
  assert.equal(notifications, before);
  assert.equal(draft.appended.length, 0);
  assert.equal(draft.blocks, 0);
  assert.equal(draft.releases, 2);
  store.dispose();
});

test('refresh metadata never persists bytes and restored unfinished files require reselection', () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  const { store } = uploadHarness({ storage });
  const draft = new Draft('session');
  store.receive([new File(['secret bytes not to serialize'], 'report.txt')], composer(draft));
  const metadata = [...data.values()][0]!;
  assert.doesNotMatch(metadata, /secret bytes|path|base64|file":/);
  assert.deepEqual(JSON.parse(metadata), [{ sessionId: 'session', id: 'operation-1', name: 'report.txt', size: 29 }]);
  store.dispose();
  const next = uploadHarness({ storage });
  const refreshed = new Draft('session');
  const unmount = next.store.subscribe(refreshed, () => {});
  assert.equal(refreshed.blocks, 1);
  assert.equal(next.store.snapshot(refreshed).items[0]!.status, 'reselect');
  next.store.retry(refreshed, 'operation-1');
  assert.equal(next.calls.length, 0);
  unmount();
  assert.equal(refreshed.blocks, 1, 'view unmount must not unblock an unresolved draft');
  next.store.remove(refreshed, 'operation-1');
  assert.equal(refreshed.blocks, 0);
  assert.equal(data.size, 0);
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
  assert.match(store.snapshot(draft).items[0]!.error!, /Draft temporarily unavailable/);
  assert.equal(draft.blocks, 1);
  draft.appendAttachments = append;
  store.retry(draft, 'operation-1');
  assert.equal(calls.length, 1);
  assert.equal(draft.snapshot.attachments.length, 1);
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
    return new Response(null, { status: calls.length % 2 ? 202 : 404 });
  }, apiBase, clock);
  const offA = probes.subscribe(fileUrl, () => {});
  const offB = probes.subscribe(fileUrl, () => {});
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, `/files/${fileId('abc')}/body.png`);
  assert.equal(calls[0]!.init!.method, 'HEAD');
  assert.equal(calls[0]!.init!.cache, 'no-store');
  await clock.advance(5_000);
  assert.equal(probes.snapshot(fileUrl).status, 'unavailable');
  assert.equal(probes.snapshot(fileUrl).deadline, 5_000);
  assert.ok(calls.length <= 9);
  assert.equal(clock.tasks.size, 0);
  const count = calls.length;
  offA(); offB();
  const offC = probes.subscribe(fileUrl, () => {});
  await clock.advance(5_000);
  assert.equal(calls.length, count, 'remount cannot start a new round');
  probes.retry(fileUrl);
  await settle();
  assert.equal(calls.length, count + 1);
  assert.equal(probes.snapshot(fileUrl).deadline, 15_000);
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
  assert.equal(calls.length, 1);
  off();
  probes.retry(fileUrl);
  assert.equal(calls.length, 1, 'manual retry without a consumer cannot start polling');
  const remount = probes.subscribe(fileUrl, () => {});
  assert.equal(calls.length, 2);
  remount();
  assert.equal(calls[1]!.aborted, true);
  assert.equal(clock.tasks.size, 0);
  probes.dispose();
});

test('requests that never resolve are aborted at the total deadline', async () => {
  const clock = new Clock();
  let signal: AbortSignal | undefined;
  const probes = new FileProbes((_path, init) => {
    signal = init!.signal as AbortSignal;
    return new Promise(() => {});
  }, apiBase, clock);
  probes.subscribe(fileUrl, () => {});
  await clock.advance(5_000);
  assert.equal(signal!.aborted, true);
  assert.equal(probes.snapshot(fileUrl).status, 'unavailable');
  probes.dispose();
});

test('authorization, known failure and server errors fail fast', async () => {
  for (const status of [401, 403, 410, 422, 500, 503]) {
    const clock = new Clock();
    let requests = 0;
    const probes = new FileProbes(async () => { requests++; return new Response(null, { status }); }, apiBase, clock);
    probes.subscribe(fileUrl, () => {});
    await settle();
    assert.equal(probes.snapshot(fileUrl).status, 'unavailable', String(status));
    assert.equal(clock.tasks.size, 0);
    await clock.advance(5_000);
    assert.equal(requests, 1);
    probes.dispose();
  }
  const probes = new FileProbes(async () => new Response(null, {
    status: 404, headers: { 'x-cockpit-file-state': 'failed' },
  }), apiBase, new Clock());
  probes.subscribe(fileUrl, () => {});
  await settle();
  assert.equal(probes.snapshot(fileUrl).status, 'unavailable');
  probes.dispose();
});

test('ready media shares the original deadline and falls back to download instead of infinite loading', async () => {
  const clock = new Clock();
  const probes = new FileProbes(async () => new Response(null, {
    headers: { 'content-type': 'image/png; charset=binary', 'content-length': '2048' },
  }), apiBase, clock);
  probes.subscribe(fileUrl, () => {});
  await settle();
  assert.deepEqual(probes.snapshot(fileUrl), {
    status: 'ready', round: 0, deadline: 5_000, mime: 'image/png', size: 2048, preview: 'pending',
  });
  await clock.advance(5_000);
  assert.equal(probes.snapshot(fileUrl).status, 'ready');
  assert.equal(probes.snapshot(fileUrl).preview, 'failed');
  assert.match(probes.snapshot(fileUrl).error!, /five seconds/);
  probes.retry(fileUrl);
  await settle();
  probes.mediaReady(fileUrl, 0);
  assert.equal(probes.snapshot(fileUrl).preview, 'pending', 'stale media callback ignored');
  probes.mediaReady(fileUrl, 1);
  assert.equal(probes.snapshot(fileUrl).preview, 'ready');
  assert.equal(clock.tasks.size, 0);
  await clock.advance(6_000);
  assert.equal(probes.snapshot(fileUrl).preview, 'ready');
  probes.dispose();
});

test('ordinary files finish after HEAD without fetching bytes, and media errors expose retry', async () => {
  const clock = new Clock();
  let calls = 0;
  const probes = new FileProbes(async () => {
    calls++;
    return new Response(null, { headers: { 'content-type': calls === 1 ? 'application/pdf' : 'video/mp4' } });
  }, apiBase, clock);
  probes.subscribe(fileUrl, () => {});
  await settle();
  assert.equal(probes.snapshot(fileUrl).status, 'ready');
  assert.equal(probes.snapshot(fileUrl).preview, undefined);
  assert.equal(clock.tasks.size, 0);
  await clock.advance(10_000);
  assert.equal(calls, 1);
  probes.retry(fileUrl);
  await settle();
  probes.mediaFailed(fileUrl, 1);
  assert.equal(probes.snapshot(fileUrl).preview, 'failed');
  assert.equal(clock.tasks.size, 0);
  assert.equal(previewKind('video/mp4'), 'video');
  assert.equal(previewKind('audio/mpeg'), 'audio');
  assert.equal(previewKind('text/html'), null);
  assert.equal(formatBytes(1_048_576), '1.0 MiB');
  probes.dispose();
});

test('media callbacks cannot extend a hidden round, and later playback errors still show fallback', async () => {
  const clock = new Clock();
  const probes = new FileProbes(async () => new Response(null, { headers: { 'content-type': 'video/mp4' } }), apiBase, clock);
  probes.subscribe(fileUrl, () => {});
  await settle();
  probes.setVisible(false);
  await clock.advance(5_001);
  probes.mediaReady(fileUrl, 0);
  assert.equal(probes.snapshot(fileUrl).preview, 'failed');
  probes.setVisible(true);
  probes.retry(fileUrl);
  await settle();
  probes.mediaReady(fileUrl, 1);
  assert.equal(probes.snapshot(fileUrl).preview, 'ready');
  await clock.advance(10_000);
  probes.mediaFailed(fileUrl, 1);
  assert.equal(probes.snapshot(fileUrl).preview, 'failed');
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
