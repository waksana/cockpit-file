import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DraftPurpose, DraftReference, DraftRestoreInput, DraftSchemaRegistration, DraftSchemaScope,
  DraftSubmission, ModuleDraft, ModuleDraftSnapshot, ModuleStateRegistry,
} from '@cockpit/module-api';
import { fileDraftSchema, registerFileDrafts, validateFileState, validateNativeAttachment } from './file-draft.ts';
import type { FileState } from './file-draft.ts';

function base(purpose: DraftPurpose = { kind: 'prompt' }, sessionId = 'fixture-session') {
  let snapshot: ModuleDraftSnapshot = Object.freeze({
    text: '', blocks: [], revision: 0, hasContent: false, pending: false, unconfirmed: false, retired: false,
  });
  const listeners = new Set<() => void>();
  const change = (patch: Partial<ModuleDraftSnapshot>) => {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of listeners) listener();
  };
  const reference: DraftReference = Object.freeze({
    id: crypto.randomUUID(), sessionId, purpose,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  });
  const draft: ModuleDraft = Object.freeze({
    ...reference,
    editText: (text: string) => change({ text, revision: snapshot.revision + 1, hasContent: !!text.trim() }),
    editTextIfRevision() { assert.fail('File does not edit conditional text'); },
    captureSend() { assert.fail('File does not capture send intents'); },
    block: (reason: string) => {
      const id = crypto.randomUUID();
      change({ blocks: [...snapshot.blocks, { id, reason }] });
      return () => change({ blocks: snapshot.blocks.filter(block => block.id !== id) });
    },
  });
  return { reference, draft, change, listeners };
}

function harness(existing: ReturnType<typeof base>[] = []) {
  const bases = new Map(existing.map(item => [item.reference, item]));
  const registrations: string[] = [];
  const disposers: (() => void)[] = [];
  let registration: DraftSchemaRegistration<FileState> | undefined;
  const scopes = new Map<DraftReference, DraftSchemaScope<FileState>>();
  const bytes = new Map<DraftReference, string>();
  let stopped = false;
  let failPersistence = false;
  let creates = 0;
  const prepare = (item: ReturnType<typeof base>, restore?: DraftRestoreInput) => {
    bases.set(item.reference, item);
    if (!registration || !registration.purposes.includes(item.reference.purpose.kind)) return;
    const definition = registration;
    creates++;
    let value = definition.validate(restore ? definition.persistence!.restore(restore, item.reference) : definition.create(item.reference));
    const listeners = new Set<() => void>();
    scopes.set(item.reference, {
      draft: item.reference,
      getSnapshot: () => value,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      update: change => {
        if (stopped) throw new Error('Revoked schema');
        const next = definition.validate(change(value));
        const serialized = definition.persistence!.serialize(next);
        if (failPersistence) throw new Error('Fixture storage write failed');
        value = next;
        bytes.set(item.reference, serialized);
        item.change({ hasContent: !!item.reference.getSnapshot().text.trim() || definition.hasContent(next) });
        for (const listener of listeners) listener();
        return value;
      },
    });
  };
  const state: ModuleStateRegistry = {
    chatWindow: { getSnapshot() { assert.fail('File does not read chat windows'); }, subscribe() { assert.fail('File does not subscribe to chat windows'); } },
    host: { getSnapshot: () => ({ sessionId: null, visible: true, connected: true }), subscribe: () => () => {} },
    registerDraft(definition) {
      registrations.push(definition.id);
      registration = definition as unknown as DraftSchemaRegistration<FileState>;
      for (const item of bases.values()) prepare(item);
      return {
        id: definition.id,
        forDraft: reference => {
          const owner = bases.get(reference) ?? [...bases.values()].find(item => item.draft === reference);
          if (stopped || !owner) throw new Error('Foreign or revoked reference');
          return scopes.get(owner.reference) as DraftSchemaScope<ReturnType<typeof definition.create>> | undefined;
        },
      };
    },
    register(definition) {
      registrations.push(definition.id);
      const service = definition.create();
      disposers.push(() => definition.dispose(service));
      return { id: definition.id, get: () => service };
    },
    bindDraft: reference => {
      if (stopped || !bases.has(reference)) throw new Error('Foreign or revoked reference');
      return bases.get(reference)!.draft;
    },
  };
  return {
    state, scopes, bytes, registrations, prepare,
    get creates() { return creates; },
    failPersistence() { failPersistence = true; },
    dispose() { stopped = true; for (const dispose of disposers.reverse()) dispose(); },
  };
}

const attachment = (id: string, path = id) => ({ id, value: { type: 'file' as const, path: `/fixture/${path}` } });
const submission = (draft: DraftReference): DraftSubmission => ({ id: 'captured-native-send', draft, base: draft.getSnapshot() });
const restore = (input: DraftRestoreInput) => fileDraftSchema.persistence!.restore(input, base().reference);

test('schema registers first and adapters are prepared before render for exact prompt lifetimes only', () => {
  const prompt = base();
  const h = harness([prompt]);
  const files = registerFileDrafts(h.state);
  assert.deepEqual(h.registrations, ['attachments', 'file-drafts']);
  const draft = files.get(prompt.reference)!;
  assert.equal(files.get(prompt.reference), draft);
  assert.equal(files.get(prompt.draft), draft, 'a valid scoped alias resolves through the canonical schema draft');
  const snapshot = draft.getSnapshot();
  assert.equal(draft.getSnapshot(), snapshot, 'combined snapshots are stable for external-store consumers');
  assert.equal('attachments' in prompt.reference.getSnapshot(), false, 'the base is text/schema-agnostic');
  assert.equal('appendAttachments' in prompt.draft, false);
  assert.equal(h.creates, 1);
  for (const kind of ['ask', 'plan', 'elicitation'] as const) {
    const decision = base({ kind, requestId: 'same-request-id' });
    h.prepare(decision);
    assert.equal(files.get(decision.reference), undefined);
    assert.equal(h.scopes.has(decision.reference), false);
    assert.equal(h.creates, 1, 'inapplicable drafts do not initialize file data or adapters');
  }
  const otherPrompt = base();
  h.prepare(otherPrompt);
  assert.notEqual(files.get(otherPrompt.reference), draft, 'same session does not mean same draft');
  assert.equal(h.creates, 2);
  draft.appendAttachments([attachment('original')]);
  assert.deepEqual(files.get(otherPrompt.reference)!.getSnapshot().attachments, []);
  assert.throws(() => files.get({ ...prompt.reference }), /Foreign/);
  const unsubscribe = draft.subscribe(() => {});
  assert.equal(prompt.listeners.size, 1);
  h.dispose();
  assert.equal(prompt.listeners.size, 0);
  unsubscribe();
  assert.throws(() => draft.appendAttachments([attachment('late')]), /no longer active/);
});

test('native projection contains only ready values and supports attachment-only sends without base fields', () => {
  const prompt = base();
  const h = harness([prompt]);
  const files = registerFileDrafts(h.state);
  const draft = files.get(prompt.reference)!;
  const scope = h.scopes.get(prompt.reference)!;
  assert.equal(fileDraftSchema.hasContent(scope.getSnapshot()), false);
  assert.equal(fileDraftSchema.project(scope.getSnapshot(), submission(prompt.reference)), undefined);
  draft.appendAttachments([attachment('one')]);
  const fields = fileDraftSchema.project(scope.getSnapshot(), submission(prompt.reference));
  assert.deepEqual(fields, { attachments: [{ type: 'file', path: '/fixture/one' }] });
  assert.equal(prompt.reference.getSnapshot().text, '');
  assert.equal(prompt.reference.getSnapshot().hasContent, true);
  assert.equal(fileDraftSchema.hasContent(scope.getSnapshot()), true);
  assert.doesNotMatch(JSON.stringify(fields), /revision|cf-upload|sessionId|"text"|version/);
  assert.match(h.bytes.get(prompt.reference)!, /"version":1/);
  assert.match(h.bytes.get(prompt.reference)!, /"id":"one"/);
  h.dispose();
});

test('ACK preserves concurrent additions and replacements including the same ID with identical native bytes', () => {
  const prompt = base();
  const h = harness([prompt]);
  const draft = registerFileDrafts(h.state).get(prompt.reference)!;
  const scope = h.scopes.get(prompt.reference)!;
  draft.appendAttachments([attachment('same'), attachment('unchanged')]);
  const captured = scope.getSnapshot();
  const send = submission(prompt.reference);
  prompt.change({ pending: true });
  draft.appendAttachments([attachment('same'), attachment('added')]);
  assert.throws(() => draft.removeAttachment('same'), /正在提交/);
  scope.update(current => fileDraftSchema.acknowledge(current, captured, send));
  assert.deepEqual(draft.getSnapshot().attachments.map(item => item.id), ['same', 'added']);
  assert.deepEqual(captured.attachments.map(item => item.id), ['same', 'unchanged']);
  const next = scope.getSnapshot();
  scope.update(current => fileDraftSchema.acknowledge(current, next, send));
  const saved = h.bytes.get(prompt.reference)!;
  assert.equal(fileDraftSchema.project(scope.getSnapshot(), send), undefined);
  assert.deepEqual(restore({ stored: { present: true, value: saved }, legacyRecord: { attachments: [attachment('old')] } }).attachments, []);
  h.dispose();
});

test('restore migrates only absent namespaces and explicit empty tombstones never reimport legacy attachments', () => {
  const legacyRecord = { text: 'untouched', unconfirmed: true, attachments: [attachment('restored')], otherModule: { value: 42 } };
  const migrated = restore({ stored: { present: false }, legacyRecord });
  assert.equal(migrated.attachments[0]!.id, 'restored');
  assert.equal(migrated.attachments[0]!.revision, 1);
  assert.deepEqual(legacyRecord.attachments, [attachment('restored')]);
  const empty = fileDraftSchema.persistence!.serialize({ revision: 8, attachments: [] });
  assert.deepEqual(restore({ stored: { present: true, value: empty }, legacyRecord }), { revision: 8, attachments: [] });
  assert.deepEqual(restore({ stored: { present: false }, legacyRecord: undefined }), { revision: 0, attachments: [] });
  assert.deepEqual(restore({ stored: { present: false }, legacyRecord: { text: 'legacy text only' } }).attachments, []);
});

test('restored scopes prepare their adapter before lookup without regenerating data during render', () => {
  const h = harness();
  const files = registerFileDrafts(h.state);
  const restored = base();
  h.prepare(restored, { stored: { present: false }, legacyRecord: { attachments: [attachment('legacy')] } });
  const draft = files.get(restored.reference)!;
  assert.equal(draft.getSnapshot().attachments[0]!.id, 'legacy');
  assert.equal(files.get(restored.reference), draft);
  assert.equal(h.creates, 1);
  draft.removeAttachment('legacy');
  assert.deepEqual(draft.getSnapshot().attachments, []);
  assert.match(h.bytes.get(restored.reference)!, /"attachments":\[\]/);
  h.dispose();
});

test('malformed stored data, duplicate IDs, oversized lists and native descriptors fail without empty fallback', () => {
  for (const value of [undefined, null, {}, '', 'not JSON', '{"version":2}', '{"version":1,"revision":0,"attachments":"bad"}',
    '{"version":1,"revision":0,"attachments":[],"unknown":true}']) {
    assert.throws(() => restore({ stored: { present: true, value }, legacyRecord: { attachments: [attachment('must-not-fallback')] } }));
  }
  for (const attachments of [null, [attachment('same'), attachment('same')], [{ id: '', value: attachment('x').value }],
    Array.from({ length: 21 }, (_, index) => attachment(String(index))),
    [{ id: 'omitted', value: { type: 'blob', mimeType: 'image/png', omittedReason: 'too_large' } }],
    [{ id: 'file-object', value: new File(['a'], 'a') }]]) {
    assert.throws(() => restore({ stored: { present: false }, legacyRecord: { attachments } }));
  }
  assert.throws(() => validateFileState({ revision: 0, attachments: [{ ...attachment('bad'), revision: 1 }] }));
});

test('native value validation preserves all existing send shapes and freezes captured nested selections', () => {
  for (const value of [
    { type: 'file', path: '/fixture/file', displayName: '' },
    { type: 'directory', path: '/fixture/directory' },
    { type: 'blob', data: 'YQ==', mimeType: 'text/plain' },
    { type: 'selection', filePath: '/fixture/code', displayName: 'Code', text: '',
      selection: { start: { line: 0, character: 0 }, end: { line: 1, character: 3 } } },
  ]) {
    const parsed = validateNativeAttachment(value);
    assert.deepEqual(parsed, value);
    assert.equal(Object.isFrozen(parsed), true);
    if (parsed.type === 'selection' && parsed.selection) {
      assert.equal(Object.isFrozen(parsed.selection.start), true);
      assert.throws(() => { (parsed.selection!.start as { line: number }).line = 9; });
    }
  }
  for (const value of [
    { type: 'file', path: '' }, { type: 'directory', path: '/a', extra: true },
    { type: 'blob', data: 42, mimeType: 'text/plain' },
    { type: 'selection', filePath: '/a', displayName: 'a', selection: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } } },
  ]) assert.throws(() => validateNativeAttachment(value));
});

test('schema actions preserve ordering and failed validation/persistence retains prior data and bytes', () => {
  const prompt = base();
  const h = harness([prompt]);
  const draft = registerFileDrafts(h.state).get(prompt.reference)!;
  draft.appendAttachments([attachment('one'), attachment('two')]);
  draft.appendAttachments([attachment('one', 'replacement')]);
  assert.deepEqual(draft.getSnapshot().attachments.map(item => item.id), ['two', 'one']);
  const previous = draft.getSnapshot();
  const bytes = h.bytes.get(prompt.reference);
  assert.throws(() => draft.appendAttachments(Array.from({ length: 19 }, (_, index) => attachment(`extra-${index}`))), /20/);
  assert.equal(draft.getSnapshot(), previous);
  assert.equal(h.bytes.get(prompt.reference), bytes);
  h.failPersistence();
  assert.throws(() => draft.removeAttachment('one'), /storage write failed/);
  assert.equal(draft.getSnapshot(), previous);
  assert.equal(h.bytes.get(prompt.reference), bytes);
  h.dispose();
});
