import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeNativeBlob, unavailableBlobReason } from './blob.ts';

test('native blob decoding preserves bytes across chunk boundaries and creates no network request', async () => {
  const bytes = Buffer.alloc(70_001);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const blob = decodeNativeBlob({ type: 'blob', mimeType: 'Application/Octet-Stream', data: bytes.toString('base64') }, bytes.length);
  assert.equal(blob.type, 'application/octet-stream');
  assert.equal(blob.size, bytes.length);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  assert.equal(decodeNativeBlob({ type: 'blob', mimeType: 'text/plain', data: '' }, 1).size, 0);
  assert.equal(await decodeNativeBlob({ type: 'blob', mimeType: 'text/plain', data: 'eA' }, 1).text(), 'x');
});

test('missing, omitted, invalid and oversized blob bytes never become a fabricated ready resource', () => {
  for (const omittedReason of ['too_large', 'asset_unavailable', 'future_reason', undefined]) {
    const attachment = { type: 'blob' as const, mimeType: 'image/png', omittedReason };
    assert.ok(unavailableBlobReason(attachment));
    assert.throws(() => decodeNativeBlob(attachment, 100));
  }
  assert.throws(() => decodeNativeBlob({ type: 'blob', mimeType: 'image/png', data: 'eA==', omittedReason: 'too_large' }, 100));
  for (const data of ['!', 'A', 'AA=A', 'AAAA====', `${'A'.repeat(65_532)}AA==AAAA`]) {
    assert.throws(() => decodeNativeBlob({ type: 'blob', mimeType: 'text/plain', data }, 100_000));
  }
  assert.throws(() => decodeNativeBlob({ type: 'blob', mimeType: 'text/plain', data: 'eHg=' }, 1), /大小限制/);
  assert.throws(() => decodeNativeBlob({ type: 'blob', mimeType: 'text/plain', data: 'eHh4eA==' }, 1), /大小限制/);
});
