import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDocument } from './document.ts';

test('document loading uses the module request and rejects redirects to unexpected response types', async () => {
  const signal = new AbortController().signal;
  const context = {
    apiBase: '/module/api',
    async request(path: string, options?: RequestInit) {
      assert.equal(path, '/files/f_a/body.md?preview=1');
      assert.equal(options?.signal, signal);
      return new Response('<h1>Rendered</h1>', { headers: { 'content-type': 'text/html; charset=utf-8', 'x-file-preview': 'markdown' } });
    },
  };
  assert.equal(await loadDocument(context, '/module/api/files/f_a/body.md', signal), '<h1>Rendered</h1>');
  for (const status of [401, 413, 422, 500]) {
    await assert.rejects(loadDocument({ ...context, request: async () => new Response('error', { status }) },
      '/module/api/files/f_a/body.md', signal), /原件仍可下载/);
  }
  await assert.rejects(loadDocument({ ...context, request: async () => new Response('login', { headers: { 'content-type': 'text/html' } }) },
    '/module/api/files/f_a/body.md', signal), /请求失败/);
});
