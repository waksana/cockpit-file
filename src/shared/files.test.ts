import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeMessageReference, encodeMessageReference, fileRequestPath, isFileId,
  isLocalFileReference, managedFileUrl, messageFileUrl, nativeFileUrl, toNativePath, toFileUrl,
} from './files.ts';

const apiBase = `/_modules/cockpit-file/${'b'.repeat(64)}/api`;
const origin = { sessionId: 'session-雪', messageId: 'message #%/1', agentId: 'agent-2' };
const fileId = `f_${'a'.repeat(64)}`;

test('managed URLs validate opaque identity and stay under the module API', () => {
  assert.equal(managedFileUrl(apiBase, fileId, 'body.png'), `${apiBase}/files/${fileId}/body.png`);
  assert.equal(managedFileUrl(`${apiBase}/`, fileId, 'body.png'), `${apiBase}/files/${fileId}/body.png`);
  for (const id of ['', '.', '..', 'a/b', '%2f', 'id#fragment', 'a b', '雪', 'abc',
    `f_${'A'.repeat(64)}`, `f_${'a'.repeat(63)}`, `f_${'a'.repeat(65)}`, `f_${'z'.repeat(64)}`]) {
    assert.equal(isFileId(id), false, id);
    assert.throws(() => managedFileUrl(apiBase, id, 'body.png'));
  }
  for (const base of ['javascript:alert(1)', 'data:text/html,hello', 'file:///api', 'https://user:pass@other.test/api',
    '//other.test', '/api?x=y', '/api#id', '/api\\file', ' https://host.test/api']) {
    assert.throws(() => managedFileUrl(base, fileId, 'body.png'));
  }
});

test('host-provided absolute HTTP API URLs retain their deployment prefix', () => {
  for (const base of [`https://host.test/cockpit${apiBase}`, `http://localhost:3000${apiBase}`]) {
    const url = managedFileUrl(base, fileId, 'body.png');
    assert.equal(url, `${base}/files/${fileId}/body.png`);
    assert.equal(nativeFileUrl(`/data/files/${fileId}/ready/body.png`, '/data/files/', base), url);
    assert.equal(fileRequestPath(base, url), `/files/${fileId}/body.png`);
    const reply = messageFileUrl(base, origin, './雪.png');
    assert.equal(fileRequestPath(base, reply), `/messages/${encodeMessageReference(origin, './雪.png')}`);
    assert.throws(() => fileRequestPath(base, `https://wrong-origin.test/files/abc`));
  }
});

test('only owned canonical native file paths map to managed URLs', () => {
  const prefix = '/data/module/files/';
  assert.equal(nativeFileUrl(`${prefix}${fileId}/ready/body.png`, prefix, apiBase), `${apiBase}/files/${fileId}/body.png`);
  assert.equal(nativeFileUrl(`${prefix}${fileId}/ready/body`, prefix, apiBase), `${apiBase}/files/${fileId}/body`);
  const unicodePrefix = '/data/雪 space%25#x/files/';
  assert.equal(nativeFileUrl(`${unicodePrefix}${fileId}/ready/body.png`, unicodePrefix, apiBase), `${apiBase}/files/${fileId}/body.png`);
  for (const path of [
    `/data/module/files2/${fileId}/ready/body.png`, '/etc/passwd',
    `${prefix}${fileId}`, `${prefix}${fileId}/`, `${prefix}${fileId}/../outside`,
    `${prefix}../original`, `${prefix}${fileId}/..`, `${prefix}${fileId}/.`,
    `${prefix}%2f/ready/body`, `${prefix}${fileId}//body`, `${prefix}${fileId}\\outside/body`,
    `${prefix}${fileId}/identity.json`, `${prefix}${fileId}/state.json`,
    `${prefix}${fileId}/ready/identity.json`, `${prefix}${fileId}/ready/body.HTML`,
    `${prefix}${fileId}/ready/body.longextensionname`, `${prefix}${fileId}/other/body.png`,
    `${prefix}${fileId}/ready/body.png/extra`, `${prefix}abc/ready/body.png`,
    `${prefix}${fileId}/ready/雪 space%25#x.png`,
  ]) assert.equal(nativeFileUrl(path, prefix, apiBase), null, path);
  assert.equal(nativeFileUrl(`/data/module/${fileId}/ready/body`, '', apiBase), null);
  assert.equal(nativeFileUrl(`/data/../files/${fileId}/ready/body`, '/data/../files/', apiBase), null);
});

test('message codec round trips exact Unicode, percent, spaces and fragments', () => {
  for (const reference of [
    './雪 space%25.png#preview', '../目录/report.csv', '/home/user/100% done.pdf',
    'file:///home/user/%E9%9B%AA%20space.png#p2', './a/abc.png', './b/abc.png',
  ]) {
    const encoded = encodeMessageReference(origin, reference);
    assert.match(encoded, /^[\w-]+$/);
    assert.deepEqual(decodeMessageReference(encoded), {
      origin: { sessionId: origin.sessionId, messageId: origin.messageId }, reference,
    });
    assert.equal(messageFileUrl(apiBase, origin, reference), `${apiBase}/messages/${encoded}`);
    const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)))),
      [origin.sessionId, origin.messageId, reference]);
  }
});

test('agent aliases are display-only while root session, message and reference identify the file', () => {
  const primary = { sessionId: 'sid', messageId: 'mid' };
  const encoded = encodeMessageReference(primary, './one');
  assert.deepEqual(JSON.parse(atob(encoded.replaceAll('-', '+').replaceAll('_', '/'))), ['sid', 'mid', './one']);
  assert.deepEqual(decodeMessageReference(encoded), { origin: primary, reference: './one' });
  assert.equal(encoded, encodeMessageReference({ ...primary, agentId: 'worker' }, './one'));
  assert.equal(encoded, encodeMessageReference({ ...primary, agentId: 'different-owner-alias' }, './one'));
  assert.notEqual(encoded, encodeMessageReference({ ...primary, sessionId: 'other-root' }, './one'));
  assert.notEqual(encoded, encodeMessageReference({ ...primary, messageId: 'other-message' }, './one'));
  assert.notEqual(encoded, encodeMessageReference(primary, './one#two'));
});

test('only local file reference schemes are candidates', () => {
  for (const reference of ['./one.png', '../one.png', '/one.png', 'report.csv', 'file:///one.png', 'file://localhost/one.png']) {
    assert.equal(isLocalFileReference(reference), true, reference);
  }
  for (const reference of [
    '', '#heading', '?query', 'http://example/a', 'https://example/a', '//example/a',
    'data:image/png;base64,a', 'javascript:alert(1)', 'mailto:a@b', 'blob:https://example/a',
    'file://remote.example/one', '\\\\server\\one', './a\u0000.png', ' leading.png', 'trailing.png ',
  ]) {
    assert.equal(isLocalFileReference(reference), false, reference);
    assert.throws(() => encodeMessageReference(origin, reference));
  }
});

test('decoder rejects malformed, noncanonical and remote references', () => {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  for (const encoded of [
    '', '=', 'A', '////', '_w', encode(['sid', 'mid']),
    encode(['sid', 'mid', 'https://example/a']),
    encode(['sid', '', './a']), encode(['sid', 'mid', {}]),
    encode(['sid', 'mid', null, './a']),
    encode(['sid', 'mid', 'legacy-agent-alias', './a']),
    `${encodeMessageReference(origin, './a')}=`,
  ]) assert.throws(() => decodeMessageReference(encoded), encoded);
  assert.throws(() => encodeMessageReference({ sessionId: '', messageId: 'm' }, './a'));
});

test('HTTP request paths are derived from module-owned file URLs', () => {
  assert.equal(fileRequestPath(apiBase, managedFileUrl(apiBase, fileId, 'body.png')), `/files/${fileId}/body.png`);
  const url = messageFileUrl(apiBase, origin, './snow');
  assert.equal(fileRequestPath(apiBase, url), url.slice(apiBase.length));
  assert.throws(() => fileRequestPath(apiBase, '/api/other/files/abc'));
  assert.throws(() => fileRequestPath(apiBase, 'https://evil.test/api/modules/cockpit-file/files/abc'));
});

test('canonical managed URLs and native paths are inverse without metadata or I/O', () => {
  for (const prefix of ['/data/files/', '/data/雪 space/files/']) {
    for (const base of [apiBase, `https://host.test/prefix${apiBase}`]) {
      for (const body of ['body', 'body.png', 'body.txt', 'body.pdf']) {
        const native = `${prefix}${fileId}/ready/${body}`;
        const url = toFileUrl(native, prefix, base);
        assert.ok(url);
        assert.equal(toNativePath(url, prefix, base), native);
        assert.equal(toFileUrl(toNativePath(url, prefix, base), prefix, base), url);
        assert.throws(() => toNativePath(`${url}?download=1`, prefix, base));
      }
    }
  }
  assert.throws(() => toNativePath(`${apiBase}/files/${fileId}/metadata.json`, '/data/files/', apiBase));
  assert.throws(() => toNativePath(`${apiBase}/files/${fileId}/body.png`, '/data/../files/', apiBase));
});
