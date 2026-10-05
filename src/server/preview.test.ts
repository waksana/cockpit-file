import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { documentKind, DOCUMENT_CSP, MAX_PREVIEW_BYTES } from '../shared/documents.ts';
import { renderDocument } from './document-renderer.ts';
import { readDocument, renderIsolated } from './preview.ts';
import { FileStorageError } from './storage.ts';

test('document recognition is separate from trusted inline media and uses stored names', () => {
  for (const name of ['README.md', 'notes.MARKDOWN']) assert.equal(documentKind({ name, mime: 'application/octet-stream' }), 'markdown');
  for (const name of ['page.HTML', 'page.htm']) assert.equal(documentKind({ name, mime: 'application/octet-stream' }), 'html');
  for (const name of ['file.txt', 'file.pdf', 'file.html.exe']) assert.equal(documentKind({ name, mime: 'application/octet-stream' }), undefined);
  assert.equal(documentKind({ name: 'fake.md', mime: 'image/png' }), undefined);
});

test('Markdown renders GFM without interpreting raw HTML', () => {
  const html = renderDocument('# Heading\n\n**Bold** and `code`\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Done\n\n```js\n<script>alert(1)</script>\n```\n\n<script>alert(2)</script>', 'markdown', '<Title>', 'host.test');
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|alert\(2\)/);
  assert.match(html, /<title>&lt;Title&gt;<\/title>/);
});

test('HTML preserves static styles but removes active elements and resource URLs', () => {
  const html = renderDocument(`<html><head><style>p{color:red}body{background:url(https://external.test/beacon)}</style>
    <link rel="stylesheet" href="./style.css"><base href="https://host.test/">
    <meta http-equiv="refresh" content="0;url=https://host.test/"></head><body>
    <p style="color: blue" onclick="alert(1)">Hi</p><script>parent.secret()</script>
    <iframe src="https://host.test/"></iframe><object data="./a"></object>
    <svg onload="alert(2)"><a href="javascript:alert(3)">bad</a></svg>
    <form action="https://host.test/api"><input name="x" type="submit"></form>
    <img src="./image.png" alt="Local image"><img src="https://external.test/pixel">
    <img src="data:image/png;base64,aGVsbG8=" alt="embedded">
    </body></html>`, 'html', 'page.html', 'host.test');
  assert.match(html, /<style>p\{color:red\}/);
  assert.match(html, /<p style="color:blue">Hi<\/p>/);
  assert.match(html, /Image unavailable: Local image/);
  assert.match(html, /src="data:image\/png;base64,aGVsbG8="/);
  assert.doesNotMatch(html, /<(?:script|iframe|object|svg|form|link|base)\b|onclick|onload|http-equiv="refresh"|name="x"|type="submit"/);
  assert.match(DOCUMENT_CSP, /^sandbox allow-popups allow-popups-to-escape-sandbox;/);
  assert.doesNotMatch(DOCUMENT_CSP, /allow-scripts|allow-same-origin|allow-forms|allow-top-navigation/);
  assert.match(DOCUMENT_CSP, /default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:/);
  assert.match(DOCUMENT_CSP, /base-uri 'none'; form-action 'none'; frame-ancestors 'self'/);
});

test('links cannot inherit the srcdoc Host base or open Host, local or executable URLs', () => {
  for (const target of ['#fragment', './file', '/api', '//external.test/', 'javascript:alert(1)', 'data:text/html,bad',
    'file:///etc/passwd', 'https://host.test/api', 'http://HOST.TEST.:9999/', 'https://u:p@external.test/',
    'http://127.1/', 'http://2130706433/', 'http://localhost/', 'http://192.168.1.1/', 'http://internal/',
    'https://host.test\\@external.test/', 'http://[::1]/']) {
    const html = renderDocument(`<a href="${target}">Blocked</a>`, 'html', 'links.html', 'host.test:8080');
    assert.doesNotMatch(html, /<a\b/, target);
  }
  assert.match(renderDocument('<a href="https://example.com/doc?a=1&amp;b=2" target="_top" ping="https://host.test/">External</a>',
    'html', 'links.html', 'host.test'), /<a href="https:\/\/example.com\/doc\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">External<\/a>/);
  assert.doesNotMatch(renderDocument('<a href="https://example.com">No host</a>', 'html', 'links.html', ''), /<a\b/);
});

test('document reads reject oversize, invalid UTF-8, binary and cancelled input', async () => {
  const signal = new AbortController().signal;
  assert.equal(await readDocument(Readable.from([Buffer.from('Hello')]), signal), 'Hello');
  assert.equal(await readDocument(Readable.from([]), signal), '');
  for (const bytes of [Buffer.from([0xff]), Buffer.from('a\0b')]) {
    await assert.rejects(readDocument(Readable.from([bytes]), signal), /UTF-8/);
  }
  await assert.rejects(readDocument(Readable.from([Buffer.alloc(MAX_PREVIEW_BYTES + 1)]), signal), /2 MiB/);
  await assert.rejects(readDocument(Readable.from([Buffer.from('x')]), AbortSignal.abort()), /aborted/);
});

test('isolated parser bounds hostile nesting without blocking the Host event loop and can be cancelled', async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const started = Date.now();
  try {
    await assert.rejects(renderIsolated('> '.repeat(10_000) + 'x', 'markdown', 'deep.md', 'host.test', new AbortController().signal),
      error => error instanceof FileStorageError && error.code === 'LIMIT_EXCEEDED');
    assert.ok(Date.now() - started < 5_000);
    assert.ok(ticks > 0, 'the main event loop stays responsive while parsing');
    const controller = new AbortController();
    const work = renderIsolated('> '.repeat(10_000) + 'x', 'markdown', 'deep.md', 'host.test', controller.signal);
    controller.abort();
    await assert.rejects(work, error => error instanceof FileStorageError && error.code === 'ABORTED');
    assert.match(await renderIsolated('# Still works', 'markdown', 'ok.md', 'host.test', new AbortController().signal), /<h1>Still works<\/h1>/);
  } finally { clearInterval(timer); }
});
