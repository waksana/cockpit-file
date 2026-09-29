import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { FileDrafts, fileDraftSchema } from '../../src/web/file-draft.ts';
import { UploadStore } from '../../src/web/file-state.ts';

const host = process.env.COCKPIT_HOST_SOURCE;
if (!host) throw new Error('COCKPIT_HOST_SOURCE must identify the pinned integration host');
const { createDraftOwner } = await import(pathToFileURL(resolve(host, 'apps/web/src/lib/textDraft.ts')).href);
const { RegisteredDraftSchema } = await import(pathToFileURL(resolve(host, 'apps/web/src/lib/draftSchemas.ts')).href);
const facts = { editable: true, submittable: true, capabilities: { attachments: true }, actionRevision: 0 };
const attachment = id => ({ id, value: { type: 'file', path: `/synthetic/${id}` } });
const accepted = request => ({ status: 'accepted', receipt: { requestId: request.requestId } });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { values = new Map(), send, acknowledge, withSchema = true } = {}) {
  const errors = [], sent = [], inspected = [], bindings = [];
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const validateRequest = value => {
    assert.equal(typeof value.requestId, 'string');
    assert.equal(typeof value.text, 'string');
    assert.deepEqual(Object.keys(value).sort(), ['actionRevision', 'attachments', 'requestId', 'text']);
    return value;
  };
  const { owner, core } = createDraftOwner({
    key: 'inbox', purpose: { kind: 'prompt' }, facts,
    prepare: snapshot => {
      assert.ok(Object.keys(snapshot.fields).every(key => key === 'attachments'));
      return { requestId: snapshot.id, text: snapshot.text, actionRevision: snapshot.base.actionRevision,
        attachments: snapshot.fields.attachments ?? [] };
    },
    validateRequest,
    validateReceipt: value => { assert.equal(typeof value.requestId, 'string'); return value; },
    send: request => { sent.push(request); return send ? send(request) : Promise.resolve(accepted(request)); },
    inspect: async request => { inspected.push(request); return accepted(request); },
  }, storage, 'synthetic-owner:inbox', error => errors.push(error));
  let schema, files, draft;
  if (withSchema) {
    schema = new RegisteredDraftSchema(crypto.randomUUID(), 'cockpit-file',
      { ...fileDraftSchema, ...(acknowledge ? { acknowledge } : {}) }, error => errors.push(error));
    schema.prepare(core);
    schema.activate();
    files = new FileDrafts(schema.handle, reference => {
      assert.equal(reference, owner.reference);
      const binding = core.bindModule('cockpit-file', [], error => errors.push(error), () => true);
      bindings.push(binding);
      return binding.draft;
    });
    files.prepare(owner.reference);
    draft = files.get(owner.reference);
  }
  t.after(() => { files?.dispose(); schema?.dispose(); core.suspend(); });
  return { owner, core, draft, schema, files, sent, inspected, values, errors };
}

test('real owner submits attachment-only and mixed content, then ACKs only captured revisions', async t => {
  for (const text of ['', 'mixed']) {
    let finish;
    const f = fixture(t, { send: () => new Promise(resolve => { finish = resolve; }) });
    assert.equal('sessionId' in f.owner.reference, false);
    assert.equal('sessionId' in f.draft, false);
    f.owner.editText(text);
    f.draft.appendAttachments([attachment('old'), attachment('same')]);
    const stop = f.draft.subscribe(() => f.draft.getSnapshot());
    const pending = f.owner.submit();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].text, text);
    assert.deepEqual(f.sent[0].attachments, [attachment('old').value, attachment('same').value]);
    assert.throws(() => f.draft.removeAttachment('old'), /提交尚未确认/);
    f.owner.editText('new text');
    f.draft.appendAttachments([attachment('new'), attachment('same')]);
    f.owner.update({ ...facts, actionRevision: 1 });
    finish(accepted(f.sent[0]));
    assert.deepEqual(await pending, { status: 'acknowledged' });
    assert.equal(f.owner.reference.getSnapshot().text, 'new text');
    assert.deepEqual(f.draft.getSnapshot().attachments.map(item => item.id), ['new', 'same']);
    stop();
  }
});

test('real recovery rebinds File schema authority and preserves newer same-value replacements', async t => {
  let finish;
  const f = fixture(t, { send: () => new Promise(resolve => { finish = resolve; }) });
  f.draft.appendAttachments([attachment('old'), attachment('same')]);
  const pending = f.owner.submit();
  const id = f.owner.reference.getSnapshot().submissionId;
  f.owner.editText('new');
  f.draft.appendAttachments([attachment('same'), attachment('new')]);
  f.core.suspend(); f.schema.dispose(); f.files.dispose();
  const restored = fixture(t, { values: f.values });
  assert.notEqual(restored.owner.reference.id, f.owner.reference.id);
  assert.equal(restored.draft.getSnapshot().unconfirmed, true);
  assert.throws(() => restored.draft.removeAttachment('old'), /提交尚未确认/);
  assert.equal(restored.sent.length + restored.inspected.length, 0);
  assert.deepEqual(await restored.owner.reconcile(id), { status: 'acknowledged' });
  assert.deepEqual(restored.draft.getSnapshot().attachments.map(item => item.id), ['same', 'new']);
  assert.equal(restored.owner.reference.getSnapshot().text, 'new');
  finish(accepted(f.sent[0]));
  assert.equal((await pending).status, 'unconfirmed');
  assert.deepEqual(restored.draft.getSnapshot().attachments.map(item => item.id), ['same', 'new']);
});

test('unknown and accepted-but-unsettled uploads cannot be discarded; later uploads remain independent', async t => {
  for (const outcome of ['unknown', 'accepted']) {
    let failAck = outcome === 'accepted', operation = 0;
    const f = fixture(t, {
      send: async request => outcome === 'unknown' ? { status: 'unknown', reason: 'lost reply' } : accepted(request),
      acknowledge: (...args) => { if (failAck) throw new Error('synthetic settlement failure'); return fileDraftSchema.acknowledge(...args); },
    });
    const deleted = [];
    const uploads = new UploadStore({
      apiBase: '/_modules/cockpit-file/fixture/api', nativePathPrefix: '/synthetic/files/',
      operationId: () => `operation-${++operation}`, report: error => f.errors.push(error),
      request: async (path, init) => {
        if (init.method === 'DELETE') { deleted.push(path); return new Response(null, { status: 204 }); }
        const id = `f_${String(operation).padStart(64, '0')}`;
        return Response.json({ fileId: id, attachment: { type: 'file', path: `/synthetic/files/${id}/ready/body.txt` } });
      },
    });
    t.after(() => uploads.dispose());
    const target = { draft: f.draft, operation: 'prompt', disabled: false };
    uploads.receive([new File(['one'], 'one')], target);
    await tick();
    assert.equal((await f.owner.submit()).status, 'unconfirmed');
    const captured = f.draft.getSnapshot().attachments[0].id;
    uploads.removeAttachment(f.draft, captured);
    assert.equal(f.draft.getSnapshot().attachments.length, 1);
    uploads.receive([new File(['two'], 'two')], target);
    await tick();
    uploads.removeAttachment(f.draft, 'cf-upload:operation-2');
    await tick();
    assert.deepEqual(deleted, ['/uploads/operation-2']);
    uploads.receive([new File(['three'], 'three')], target);
    await tick();
    failAck = false;
    assert.deepEqual(await f.owner.reconcile(f.owner.reference.getSnapshot().submissionId), { status: 'acknowledged' });
    assert.equal(f.sent.length, 1, 'recovery never resends the business request');
    assert.deepEqual(f.draft.getSnapshot().attachments.map(item => item.id), ['cf-upload:operation-3']);
    assert.deepEqual(deleted, ['/uploads/operation-2'], 'ACK retains the delivered entity');
    uploads.removeAttachment(f.draft, 'cf-upload:operation-3');
    await tick();
    assert.deepEqual(deleted, ['/uploads/operation-2', '/uploads/operation-3'],
      'receipt reconciliation does not capture or consume newer upload ownership');
  }
});

test('missing/restored schemas, owner capabilities and retirement retain explicit host gates', async t => {
  const f = fixture(t);
  f.draft.appendAttachments([attachment('saved')]);
  f.owner.update({ ...facts, capabilities: { attachments: false } });
  assert.equal((await f.owner.submit()).status, 'blocked');
  assert.equal(f.sent.length, 0);
  f.owner.update({ ...facts, editable: false });
  assert.throws(() => f.draft.appendAttachments([attachment('late')]), /read-only/);
  f.core.suspend(); f.schema.dispose(); f.files.dispose();
  const absent = fixture(t, { values: f.values, withSchema: false });
  absent.owner.editText('must not degrade to text only');
  assert.equal((await absent.owner.submit()).status, 'blocked');
  assert.equal(absent.sent.length, 0);
  absent.core.suspend();
  const restored = fixture(t, { values: f.values });
  assert.equal(restored.draft.getSnapshot().attachments[0].id, 'saved');
  restored.owner.retire();
  assert.throws(() => restored.draft.appendAttachments([attachment('retired')]), /no longer accepts/);
});
