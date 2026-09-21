import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DraftPurpose, DraftReference, DraftSchemaScope, ModuleDraft, ModuleDraftSnapshot, ModuleStateRegistry,
} from '@cockpit/module-api';
import type { ClipboardEvent, DragEvent } from 'react';
import { registerFileDrafts, type FileComposerContext, type FileState } from './file-draft.ts';
import { FileInputs } from './file-input.ts';

class NativeInput {
  type = '';
  multiple = false;
  files: readonly File[] | null = [];
  clicks = 0;
  resets = 0;
  clickFailure?: Error;
  onClick?: () => void;
  readonly listeners = new Map<string, Set<() => void>>();
  readonly callbacks = new Map<string, () => void>();
  set value(value: string) {
    assert.equal(value, '');
    this.files = [];
    this.resets++;
  }
  addEventListener(type: string, callback: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(callback);
    this.callbacks.set(type, callback);
  }
  removeEventListener(type: string, callback: () => void) { this.listeners.get(type)?.delete(callback); }
  click() {
    this.clicks++;
    if (this.clickFailure) throw this.clickFailure;
    this.onClick?.();
  }
  emit(type: string) { for (const callback of this.listeners.get(type) ?? []) callback(); }
  get listenerCount() { return [...this.listeners.values()].reduce((count, items) => count + items.size, 0); }
}

function fixture() {
  let revoked = false;
  let failCreate = false;
  let failReceive = false;
  let onClick: (() => void) | undefined;
  let clickFailure: Error | undefined;
  const signal = new AbortController();
  const errors: unknown[] = [];
  const inputs: NativeInput[] = [];
  const received: { files: readonly File[]; target: FileComposerContext }[] = [];
  const scopes = new Map<DraftReference, DraftSchemaScope<FileState>>();
  const aliases = new Map<DraftReference, DraftReference>();
  const definitions: { create(reference: DraftReference): FileState }[] = [];
  const disposers: (() => void)[] = [];
  const state: ModuleStateRegistry = {
    chatWindow: { getSnapshot() { assert.fail('Picker does not read chat windows'); }, subscribe() { assert.fail('Picker does not subscribe to chat windows'); } },
    host: { getSnapshot: () => ({ sessionId: null, visible: true, connected: true }), subscribe: () => () => {} },
    bindDraft: () => { throw new Error('Picker cannot write base draft state'); },
    registerDraft(definition) {
      definitions.push(definition as unknown as typeof definitions[number]);
      return { id: definition.id, forDraft(reference) {
        if (revoked) throw new Error('Revoked file schema');
        const canonical = aliases.get(reference);
        if (!canonical) throw new Error('Foreign draft');
        return scopes.get(canonical) as DraftSchemaScope<ReturnType<typeof definition.create>> | undefined;
      } };
    },
    register(definition) {
      const service = definition.create();
      disposers.push(() => definition.dispose(service));
      return { id: definition.id, get: () => service };
    },
  };
  const drafts = registerFileDrafts(state);
  const service = new FileInputs({
    signal: signal.signal, enabled: true,
    report: error => errors.push(error),
    uploads: { receive(files, target) {
      if (failReceive) throw new Error('Synthetic upload failure');
      received.push({ files, target });
      return true;
    } },
    page: { createElement() {
      if (failCreate) throw new Error('Synthetic input creation failure');
      const input = new NativeInput();
      input.clickFailure = clickFailure;
      input.onClick = onClick;
      inputs.push(input);
      return input as unknown as HTMLInputElement;
    } } as Pick<Document, 'createElement'>,
  });
  const makeDraft = (sessionId = 'synthetic-session', purpose: DraftPurpose = { kind: 'prompt' }) => {
    let snapshot: ModuleDraftSnapshot = {
      text: '', revision: 0, blocks: [], pending: false, unconfirmed: false, hasContent: false, retired: false,
    };
    const reference: DraftReference = Object.freeze({
      id: crypto.randomUUID(), sessionId, purpose,
      getSnapshot: () => snapshot, subscribe: () => () => {},
    });
    const alias: ModuleDraft = {
      ...reference, editText() { throw new Error('No text edits'); }, block() { throw new Error('No blocks'); },
      editTextIfRevision() { assert.fail('Picker does not edit conditional text'); },
      captureSend() { assert.fail('Picker does not capture send intents'); },
    };
    aliases.set(reference, reference);
    aliases.set(alias, reference);
    if (purpose.kind === 'prompt') {
      let value = definitions[0]!.create(reference);
      scopes.set(reference, {
        draft: reference, getSnapshot: () => value, subscribe: () => () => {},
        update(change) { value = change(value); return value; },
      });
    }
    return {
      reference, alias, files: drafts.get(alias),
      pending(value: boolean) { snapshot = { ...snapshot, pending: value }; },
    };
  };
  return {
    service, drafts, makeDraft, received, inputs, errors, signal,
    revoke() { revoked = true; },
    failCreate() { failCreate = true; },
    failReceive() { failReceive = true; },
    failClick() { clickFailure = new Error('Synthetic click failure'); },
    onClick(callback: () => void) { onClick = callback; },
    dispose() { revoked = true; service.dispose(); for (const dispose of disposers) dispose(); },
  };
}

const target = (draft: ReturnType<ReturnType<typeof fixture>['makeDraft']>): FileComposerContext => ({
  draft: draft.files!, operation: 'prompt', disabled: false,
});
const file = () => new File(['synthetic input'], 'synthetic.txt', { type: 'text/plain' });

function event(files: readonly File[], text = '', html = '') {
  const transfer = {
    files, items: [], types: files.length ? ['Files'] : ['text/plain'], dropEffect: 'none',
    getData: (type: string) => type === 'text/plain' ? text : type === 'text/html' ? html : '',
  };
  return {
    nativeEvent: {}, defaultPrevented: false, clipboardData: transfer, dataTransfer: transfer,
    preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented = true; },
  } as unknown as ClipboardEvent<HTMLDivElement> & DragEvent<HTMLDivElement>;
}

test('picker captures the actual canonical adapter at open and opens synchronously without mounting an input', () => {
  const h = fixture();
  const original = h.makeDraft('original-session');
  const next = h.makeDraft('next-session');
  const captured = target(original);
  let opened = false;
  h.onClick(() => { opened = true; });
  h.service.pick(captured);
  assert.equal(opened, true);
  const input = h.inputs[0]!;
  assert.equal(input.type, 'file');
  assert.equal(input.multiple, true);
  assert.equal(input.listenerCount, 2);
  assert.equal(h.drafts.get(original.reference), original.files, 'authorized aliases resolve to one canonical adapter');
  assert.equal(h.received.length, 0);
  assert.equal(h.drafts.get(h.makeDraft(original.reference.sessionId, { kind: 'ask', requestId: 'fixture-request' }).reference), undefined);
  (captured as { draft: FileComposerContext['draft']; disabled: boolean }).draft = next.files!;
  (captured as { disabled: boolean }).disabled = true;
  next.pending(true);
  const selected = file();
  input.files = [selected];
  input.emit('change');
  assert.equal(h.received.length, 1);
  assert.equal(h.received[0]!.target.draft, original.files);
  assert.equal(h.received[0]!.target.disabled, false);
  assert.equal(h.received[0]!.files[0], selected);
  assert.equal(input.listenerCount, 0);
  assert.deepEqual(input.files, []);
  input.callbacks.get('change')!();
  assert.equal(h.received.length, 1, 'a stale duplicate callback has no target or File references');
  h.dispose();
});

test('native cancel and empty change close callbacks without uploads or errors', () => {
  for (const kind of ['cancel', 'change']) {
    const h = fixture();
    h.service.pick(target(h.makeDraft()));
    const input = h.inputs[0]!;
    input.files = kind === 'cancel' ? [file()] : null;
    input.emit(kind);
    assert.equal(h.received.length, 0);
    assert.deepEqual(h.errors, []);
    assert.equal(input.listenerCount, 0);
    assert.deepEqual(input.files, []);
    input.files = [file()];
    input.callbacks.get('change')!();
    assert.equal(h.received.length, 0);
    h.dispose();
  }
});

test('a new picker retires the previous selection and late results never upload to either draft', () => {
  const h = fixture();
  const first = h.makeDraft();
  const next = h.makeDraft();
  h.service.pick(target(first));
  const previous = h.inputs[0]!;
  h.service.pick(target(next));
  assert.equal(previous.listenerCount, 0);
  previous.files = [file()];
  previous.callbacks.get('change')!();
  assert.equal(h.received.length, 0);
  const active = h.inputs[1]!;
  active.files = [file()];
  active.emit('change');
  assert.equal(h.received[0]!.target.draft, next.files);
  h.dispose();
});

test('pending, disabled, unavailable operation and unconfigured input cannot open or accept files', () => {
  const h = fixture();
  const draft = h.makeDraft();
  const composer = target(draft);
  for (const invalid of [{ ...composer, disabled: true }, { ...composer, operation: 'ask' as const }]) h.service.pick(invalid);
  draft.pending(true);
  h.service.pick(composer);
  assert.equal(h.inputs.length, 0);
  draft.pending(false);
  h.service.pick(composer);
  draft.pending(true);
  h.inputs[0]!.files = [file()];
  h.inputs[0]!.emit('change');
  assert.equal(h.received.length, 0);
  assert.equal(h.inputs[0]!.listenerCount, 0);
  const disabled = new FileInputs({
    enabled: false, signal: h.signal.signal, report: error => h.errors.push(error),
    uploads: { receive() { throw new Error('Must not upload'); } },
  });
  draft.pending(false);
  disabled.pick(composer);
  disabled.paste(event([file()]), composer);
  assert.deepEqual(h.errors, []);
  disabled.dispose(); h.dispose();
});

test('schema revocation reports once after closing the picker; disposal and abort ignore late callbacks', () => {
  for (const stop of ['revoke', 'dispose', 'abort'] as const) {
    const h = fixture();
    const composer = target(h.makeDraft());
    h.service.pick(composer);
    const input = h.inputs[0]!;
    const change = input.callbacks.get('change')!;
    input.files = [file()];
    if (stop === 'abort') h.signal.abort();
    else h[stop]();
    if (stop !== 'revoke') {
      assert.deepEqual(input.files, [], 'module stop clears native File references before a late callback');
      assert.equal(input.listenerCount, 0);
    }
    input.files = [file()];
    assert.doesNotThrow(change);
    assert.equal(h.received.length, 0);
    assert.equal(input.listenerCount, 0);
    assert.equal(h.errors.length, stop === 'revoke' ? 1 : 0);
    if (stop === 'revoke') assert.match(String(h.errors[0]), /Revoked file schema/);
    assert.doesNotThrow(change);
    assert.equal(h.errors.length, stop === 'revoke' ? 1 : 0);
    h.dispose();
    h.service.pick(composer);
    h.service.paste(event([file()]), composer);
    assert.equal(h.inputs.length, 1);
    assert.equal(h.received.length, 0);
  }
});

test('picker creation, opening, reading and upload failures are module reports, never uncaught callbacks', () => {
  for (const failure of ['create', 'click', 'read', 'receive'] as const) {
    const h = fixture();
    const composer = target(h.makeDraft());
    if (failure === 'create') h.failCreate();
    if (failure === 'click') h.failClick();
    if (failure === 'receive') h.failReceive();
    assert.doesNotThrow(() => h.service.pick(composer));
    const input = h.inputs[0];
    if (failure === 'read') Object.defineProperty(input, 'files', {
      configurable: true, get() { throw new Error('Synthetic selection read failure'); }, set() {},
    });
    if (failure === 'read' || failure === 'receive') {
      if (failure === 'receive') input!.files = [file()];
      assert.doesNotThrow(() => input!.emit('change'));
    }
    assert.equal(h.errors.length, 1);
    assert.match(String(h.errors[0]), /Synthetic/);
    assert.equal(h.received.length, 0);
    assert.equal(input?.listenerCount ?? 0, 0);
    h.dispose();
  }
});

test('file paste/drop own one native event and preserve mixed text/HTML and ordinary paste', () => {
  for (const kind of ['paste', 'drop'] as const) {
    for (const [text, html] of [['', ''], ['mixed text', ''], [' ', ''], ['', '<b>mixed</b>']]) {
      const h = fixture();
      const composer = target(h.makeDraft());
      const selected = file();
      const first = event([selected], text, html);
      h.service[kind](first, composer);
      h.service[kind]({ ...first }, composer);
      assert.equal(h.received.length, 1);
      assert.equal(h.received[0]!.files[0], selected);
      assert.equal(first.defaultPrevented, kind === 'drop' || (!text && !html));
      const ordinary = event([], 'ordinary text');
      h.service[kind](ordinary, composer);
      assert.equal(ordinary.defaultPrevented, false);
      assert.equal(h.received.length, 1);
      const handled = event([file()]);
      handled.preventDefault();
      h.service[kind](handled, composer);
      assert.equal(h.received.length, 1);
      h.dispose();
    }
  }
});

test('clipboard file items are a fallback, not a duplicate of the file list', () => {
  const h = fixture();
  const composer = target(h.makeDraft());
  const selected = file();
  for (const files of [[], [selected]]) {
    const paste = event(files);
    Object.assign(paste.clipboardData, { items: [
      { kind: 'file', getAsFile: () => selected }, { kind: 'file', getAsFile: () => null }, { kind: 'string' },
    ] });
    h.service.paste(paste, composer);
    assert.deepEqual(h.received.at(-1)!.files, [selected]);
  }
  assert.equal(h.received.length, 2);
  h.dispose();
});

test('drag-over advertises copy only for an available prompt and pending/disabled drops cannot upload', () => {
  const h = fixture();
  const draft = h.makeDraft();
  for (const mode of ['ready', 'disabled', 'pending']) {
    draft.pending(mode === 'pending');
    const composer = { ...target(draft), disabled: mode === 'disabled' };
    const drag = event([file()]);
    h.service.dragOver(drag, composer);
    assert.equal(drag.defaultPrevented, true);
    assert.equal(drag.dataTransfer.dropEffect, mode === 'ready' ? 'copy' : 'none');
    h.service.drop(event([file()]), composer);
    h.service.paste(event([file()]), composer);
  }
  assert.equal(h.received.length, 2);
  const text = event([], 'ordinary text');
  h.service.dragOver(text, target(draft));
  assert.equal(text.defaultPrevented, false);
  h.dispose();
});
