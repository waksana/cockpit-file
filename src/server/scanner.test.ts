import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarkdownScanner } from './scanner.ts';
import type { MarkdownReference } from './scanner.ts';

function scanParts(text: string, sizes: number[]): { references: MarkdownReference[]; scanner: ReturnType<typeof createMarkdownScanner> } {
  const scanner = createMarkdownScanner();
  const references: MarkdownReference[] = [];
  let offset = 0;
  for (const size of sizes) {
    references.push(...scanner.feed(text.slice(offset, offset + size)));
    offset += size;
  }
  references.push(...scanner.feed(text.slice(offset)), ...scanner.finish());
  return { references, scanner };
}

const examples: { title: string; text: string; references: MarkdownReference[] }[] = [
  {
    title: 'inline links, images, absolute, relative and file URL destinations',
    text: 'Here [report](./report.csv) and ![效果图](/work/image.png), [file](file:///work/a%20b.pdf).',
    references: [
      { target: './report.csv', label: 'report', image: false },
      { target: '/work/image.png', label: '效果图', image: true },
      { target: 'file:///work/a%20b.pdf', label: 'file', image: false },
    ],
  },
  {
    title: 'balanced parentheses, escapes, angle destinations and optional titles',
    text: '[a](./a(b(c)).txt "A title") [b](<./a b.txt> \'title\') [c](./a\\(b\\).txt) [d](../doc.pdf (title))',
    references: [
      { target: './a(b(c)).txt', label: 'a', image: false },
      { target: './a b.txt', label: 'b', image: false },
      { target: './a(b).txt', label: 'c', image: false },
      { target: '../doc.pdf', label: 'd', image: false },
    ],
  },
  {
    title: 'code fences and inline code do not emit links',
    text: '```md\n[x](./code.txt)\n```\n~~~\n![x](./code.png)\n~~~~\n`[x](./inline.txt)` `` [x](./two.txt) ` `` [yes](./yes.txt)',
    references: [{ target: './yes.txt', label: 'yes', image: false }],
  },
  {
    title: 'fences respect marker, length, prefix and trailing content',
    text: '   ````txt\n[x](./a)\n```\n[y](./b)\n~~~~\n[z](./c)\n```` not a close\n[k](./d)\n````  \n[yes](./yes)',
    references: [{ target: './yes', label: 'yes', image: false }],
  },
  {
    title: 'escaped openers and code markers',
    text: '\\[no](./no) \\![not-image](./a) \\`[yes](./b)\\` \\\\[also](./c)',
    references: [
      { target: './a', label: 'not-image', image: false },
      { target: './b', label: 'yes', image: false },
      { target: './c', label: 'also', image: false },
    ],
  },
  {
    title: 'remote destination policy is left to the caller',
    text: '[site](https://example.invalid/a) [mail](mailto:a@example.invalid) ![](./image.png)',
    references: [
      { target: 'https://example.invalid/a', label: 'site', image: false },
      { target: 'mailto:a@example.invalid', label: 'mail', image: false },
      { target: './image.png', image: true },
    ],
  },
  {
    title: 'raw and normalized targets are deduplicated within one message',
    text: '[first](./a\\(b\\).txt) ![again](./a\\(b\\).txt) [third](./a(b).txt) [A &amp; B](./x?a=1&amp;b=2) [same](./x?a=1&b=2)',
    references: [
      { target: './a(b).txt', label: 'first', image: false },
      { target: './x?a=1&b=2', label: 'A & B', image: false },
    ],
  },
  {
    title: 'nonlinks and unfinished links cannot create captures',
    text: '/bare/a.txt ./relative.txt file:///bare/url\n[reference][id]\n[id]: ./definition.txt\n[bad](<./bad\npath>) [label only] and [incomplete](./file',
    references: [],
  },
  {
    title: 'nested labels and escaped closing delimiters',
    text: '[outer [inner] label](./a) [a\\]b](./b) [slash](./a\\\\b.txt)',
    references: [
      { target: './a', label: 'outer [inner] label', image: false },
      { target: './b', label: 'a]b', image: false },
      { target: './a\\b.txt', label: 'slash', image: false },
    ],
  },
  {
    title: 'four-space and tab-indented code is conservatively suppressed',
    text: '    [space](./space)\n\t![tab](./tab.png)\n  \t[tabstop](./tabstop)\n     [unfinished\n\n   [three](./three)\n[normal](./normal)',
    references: [
      { target: './three', label: 'three', image: false },
      { target: './normal', label: 'normal', image: false },
    ],
  },
  {
    title: 'raw pre and script blocks including attributes and closing-tag line tails',
    text: '<PRE data-example=">[fake](./attribute)">\n[x](./pre)\n    </pRe > [tail](./tail)\n<script\n type="text/plain">\n![x](./script)\n</SCRIPT>\n[yes](./yes)',
    references: [{ target: './yes', label: 'yes', image: false }],
  },
  {
    title: 'HTML comments and additional obvious code-like elements',
    text: 'before <!-- [x](./comment)\n<pre>[nested](./nested)</pre> --> [ok](./ok)\n<style>[x](./style)</style>\n<textarea>[x](./area)</textarea>\n<code>[x](./code)</code> [next](./next)',
    references: [
      { target: './ok', label: 'ok', image: false },
      { target: './next', label: 'next', image: false },
    ],
  },
  {
    title: 'escaped tags and tags inside Markdown code do not start HTML suppression',
    text: '\\<pre> [escaped](./escaped)\n`<script>` [inline](./inline)\n```\n<!--<pre>\n```\n    <pre>\n<prefix>[name](./name)\n[yes](./yes)',
    references: [
      { target: './escaped', label: 'escaped', image: false },
      { target: './inline', label: 'inline', image: false },
      { target: './name', label: 'name', image: false },
      { target: './yes', label: 'yes', image: false },
    ],
  },
  {
    title: 'malformed Markdown prefixes cannot hide raw HTML code/comment openers',
    text: '[broken](./bad<!-- [hidden](./hidden) --> [good](./good)\n[not-link]<script>![fake](./fake)</script>\n[visible](./visible)',
    references: [
      { target: './good', label: 'good', image: false },
      { target: './visible', label: 'visible', image: false },
    ],
  },
];

for (const example of examples) {
  test(`${example.title}: every split and single-character deltas`, () => {
    for (let split = 0; split <= example.text.length; split++) {
      const { references, scanner } = scanParts(example.text, [split]);
      assert.deepEqual(references, example.references, `split ${split}`);
      assert.equal(scanner.stats.scannedChars, example.text.length);
      assert.ok(scanner.stats.transitions <= example.text.length * 2);
    }
    assert.deepEqual(scanParts(example.text, Array(example.text.length).fill(1) as number[]).references, example.references);
  });
}

test('emits at the first complete outer delimiter without waiting for finish', () => {
  const scanner = createMarkdownScanner();
  assert.deepEqual(scanner.feed('![some'), []);
  assert.deepEqual(scanner.feed('thing](./a(b'), []);
  assert.deepEqual(scanner.feed(').png "title"'), []);
  assert.deepEqual(scanner.feed(')'), [{ target: './a(b).png', label: 'something', image: true }]);
  assert.deepEqual(scanner.finish(), []);
  assert.deepEqual(scanner.finish(), []);
  assert.throws(() => scanner.feed('later'), /finished/);
});

test('bounded unfinished candidates recover at a line boundary, with bounded diagnostics', () => {
  const scanner = createMarkdownScanner({ maxCandidateChars: 64 });
  const long = `[${'x'.repeat(200_000)}[hidden](./hidden)\n[valid](./valid)\n`;
  const references: MarkdownReference[] = [];
  for (const char of long) references.push(...scanner.feed(char));
  assert.deepEqual(references, [{ target: './valid', label: 'valid', image: false }]);
  assert.equal(scanner.stats.scannedChars, long.length);
  assert.ok(scanner.stats.transitions <= long.length * 2);
  assert.ok(scanner.stats.maxBufferedChars <= 64);
  assert.equal(scanner.stats.droppedCandidates, 1);
  assert.equal(scanner.diagnostics[0]?.code, 'candidate-limit');
  for (let i = 0; i < 100; i++) scanner.feed(`[${'x'.repeat(100)}\n`);
  assert.equal(scanner.diagnostics.length, 1);
});

test('deduplication is bounded and does not normalize repeated raw targets', () => {
  const scanner = createMarkdownScanner({ maxReferences: 2 });
  assert.equal(scanner.feed('[a](./a)'.repeat(2000)).length, 1);
  assert.equal(scanner.stats.normalizations, 1);
  assert.equal(scanner.feed('[b](./b)[c](./c)[a](./a)').length, 1);
  assert.equal(scanner.stats.normalizations, 2);
  assert.equal(scanner.diagnostics[0]?.code, 'reference-limit');
});

test('scanner states are independent and preserve split Unicode surrogate pairs', () => {
  const left = createMarkdownScanner();
  const right = createMarkdownScanner();
  left.feed('`[code](./x)` ![emoji \ud83d');
  right.feed('[other](./');
  assert.deepEqual(left.feed('\ude00](./same)'), [{ target: './same', label: 'emoji 😀', image: true }]);
  assert.deepEqual(right.feed('same)'), [{ target: './same', label: 'other', image: false }]);
  assert.equal(left.stats.emittedReferences, 1);
  assert.equal(right.stats.emittedReferences, 1);
});

test('ordinary prose and code delimiter runs require only linear scanning', () => {
  const scanner = createMarkdownScanner();
  const text = 'ordinary prose\n'.repeat(10000) + '`'.repeat(100000) + '\nignored [x](./x)\n';
  for (let index = 0; index < text.length; index += 7) scanner.feed(text.slice(index, index + 7));
  assert.equal(scanner.stats.scannedChars, text.length);
  assert.ok(scanner.stats.transitions <= text.length * 2);
  assert.equal(scanner.stats.emittedReferences, 0);
  assert.equal(scanner.stats.maxBufferedChars, 0);
});

test('invalid scanner resource limits fail explicitly', () => {
  assert.throws(() => createMarkdownScanner({ maxCandidateChars: 0 }), RangeError);
  assert.throws(() => createMarkdownScanner({ maxReferences: Infinity }), RangeError);
});

test('long unfinished HTML comments and attributes retain only bounded lexical state', () => {
  for (const [opening, closing] of [['<!--', '-->'], ['<pre data-value="', '">\n</pre>\n']] as const) {
    const scanner = createMarkdownScanner({ maxCandidateChars: 32 });
    const text = opening + '[hidden](./hidden)'.repeat(20000) + closing + '[visible](./visible)';
    const references: MarkdownReference[] = [];
    for (let offset = 0; offset < text.length; offset += 3) references.push(...scanner.feed(text.slice(offset, offset + 3)));
    assert.deepEqual(references, [{ target: './visible', label: 'visible', image: false }]);
    assert.equal(scanner.stats.scannedChars, text.length);
    assert.ok(scanner.stats.transitions <= text.length * 2);
    assert.ok(scanner.stats.maxBufferedChars <= 32);
    assert.equal(scanner.stats.droppedCandidates, 0);
  }
});

test('discarding an oversized Markdown candidate still respects later HTML comment boundaries', () => {
  const scanner = createMarkdownScanner({ maxCandidateChars: 32 });
  const text = `[${'x'.repeat(100)}<!--\n[hidden](./hidden)\n-->\n[visible](./visible)`;
  const references: MarkdownReference[] = [];
  for (const char of text) references.push(...scanner.feed(char));
  assert.deepEqual(references, [{ target: './visible', label: 'visible', image: false }]);
  assert.equal(scanner.diagnostics[0]?.code, 'candidate-limit');
  assert.ok(scanner.stats.maxBufferedChars <= 32);
});
