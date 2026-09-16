import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import type { ActivateFrontend, ComposerContext, ModuleDraft, ModuleFrontend, ModuleFrontendContext, RenderNode } from '@cockpit/module-api';

const source = await readFile(new URL('./index.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React },
}).outputText
  .replaceAll("'../shared/files.ts'", JSON.stringify(new URL('../shared/files.ts', import.meta.url).href))
  .replaceAll("'./file-state.ts'", JSON.stringify(new URL('./file-state.ts', import.meta.url).href))
  .replaceAll("'./blob.ts'", JSON.stringify(new URL('./blob.ts', import.meta.url).href));
const { activate } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`) as { activate: ActivateFrontend };
const fileId = `f_${'a'.repeat(64)}`;
const apiBase = `https://host.test/cockpit/_modules/cockpit-file/${'b'.repeat(64)}/api`;

interface Element {
  type: string | ((props: Record<string, unknown>) => Element);
  props: Record<string, unknown>;
}

function harness() {
  let refIndex = 0;
  let stateIndex = 0, effectIndex = 0;
  const refs: { current: unknown }[] = [];
  const states = new Map<number, unknown>();
  const effects: { deps: readonly unknown[]; cleanup?: () => void }[] = [];
  const pendingEffects: (() => void)[] = [];
  const calls: { path: string; init?: RequestInit }[] = [];
  const signal = new AbortController();
  const errors: unknown[] = [];
  const react = {
    createElement(type: Element['type'], props: Element['props'] | null, ...children: unknown[]): Element {
      return { type, props: { ...props, children } };
    },
    useRef(initial: unknown) {
      const index = refIndex++;
      return refs[index] ??= { current: initial };
    },
    useCallback<T>(callback: T) { return callback; },
    useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { return snapshot(); },
    useState(initial?: unknown) {
      const index = stateIndex++;
      if (!states.has(index)) states.set(index, initial);
      return [states.get(index), (value: unknown) => {
        states.set(index, typeof value === 'function' ? value(states.get(index)) : value);
      }];
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = effectIndex++;
      const previous = effects[index];
      if (previous && previous.deps.every((value, at) => Object.is(value, deps[at]))) return;
      const entry = { deps, cleanup: undefined as (() => void) | undefined };
      effects[index] = entry;
      pendingEffects.push(() => { previous?.cleanup?.(); entry.cleanup = effect() || undefined; });
    },
  };
  const context: ModuleFrontendContext = {
    apiVersion: 1, moduleId: 'cockpit-file', react: react as unknown as ModuleFrontendContext['react'],
    apiBase, config: { nativePathPrefix: '/data/files/', maxBytes: 100_000 },
    signal: signal.signal, report: error => errors.push(error),
    request: async (path, init) => {
      calls.push({ path, init });
      return new Promise(() => {});
    },
  };
  return { context, refs, calls, errors, signal,
    resetHooks: () => { refIndex = 0; stateIndex = 0; effectIndex = 0; },
    flushEffects: () => { for (const effect of pendingEffects.splice(0)) effect(); },
    unmount: () => {
      for (const effect of effects.splice(0)) effect.cleanup?.();
      states.clear();
      refs.splice(0);
    },
  };
}

function children(element: Element): Element[] {
  return element.props.children as Element[];
}

test('activation uses the host React and exposes only the v1 public extension slots', async () => {
  const { context, calls, signal } = harness();
  const frontend = await activate(context);
  assert.deepEqual(frontend.writes, ['attachments']);
  assert.equal(frontend.composerActions?.length, 1);
  assert.equal(frontend.composerAbove?.length, 1);
  assert.equal(frontend.fileInput?.length, 1);
  assert.equal(frontend.chatRenderers?.length, 1);
  assert.equal(calls.length, 0, 'registration does not fetch or capture files');
  assert.equal(frontend.fileInput![0]!.accepts([]), false);
  assert.equal(frontend.fileInput![0]!.accepts([new File(['a'], 'a')]), true);
  assert.doesNotMatch(compiled, /(?:from\s*['"]react|react\/jsx-runtime|createRoot|innerHTML|sessionStore|sessionStorage|cf-pending)/);
  signal.abort();
  assert.equal(frontend.fileInput![0]!.accepts([new File(['a'], 'a')]), false);
  frontend.dispose?.();
});

function descendants(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...descendants(element.props.children)];
}

test('native blob cards decode locally, reuse their URL on rerender and revoke it on change or teardown', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const renderer = frontend.chatRenderers![0]!;
  const origin = { sessionId: 'fixture', messageId: 'blob' };
  let node: RenderNode = { kind: 'attachment', origin, label: 'Native text',
    attachment: { type: 'blob', mimeType: 'text/plain', data: 'aGVsbG8=' } };
  assert.equal(renderer.matches(node), true);
  const renderNode = renderer.component as unknown as (props: { node: RenderNode }) => Element;
  const render = () => {
    h.resetHooks();
    const element = renderNode({ node });
    assert.equal(typeof element.type, 'function');
    return typeof element.type === 'function' ? element.type(element.props) : element;
  };
  const url = (tree: Element) => String(descendants(tree).find(element => element.type === 'a')!.props.href);
  render(); h.flushEffects();
  const first = url(render());
  assert.match(first, /^blob:/);
  assert.equal(await (await fetch(first)).text(), 'hello');
  h.flushEffects();
  assert.equal(url(render()), first);
  assert.equal(h.calls.length, 0, 'inline bytes do not use module HTTP, HEAD probes or upload');
  node = { ...node, attachment: { type: 'blob', mimeType: 'text/html', data: 'PGI+c2FmZTwvYj4=' } };
  render(); h.flushEffects();
  const changed = render();
  const second = url(changed);
  assert.notEqual(second, first);
  await assert.rejects(fetch(first));
  assert.equal(await (await fetch(second)).text(), '<b>safe</b>');
  assert.equal(descendants(changed).some(element => ['iframe', 'object', 'embed'].includes(String(element.type))), false);
  assert.equal(descendants(changed).find(element => element.type === 'a')!.props.download, 'Native text');
  h.unmount();
  await assert.rejects(fetch(second));
  render(); h.flushEffects();
  const third = url(render());
  h.signal.abort();
  await assert.rejects(fetch(third));
  h.unmount();
  frontend.dispose?.();
});

test('omitted and malformed blobs show unavailable cards without download or fabricated bytes', async () => {
  for (const attachment of [
    { type: 'blob' as const, mimeType: 'image/png', omittedReason: 'too_large' },
    { type: 'blob' as const, mimeType: 'image/png', omittedReason: 'asset_unavailable' },
    { type: 'blob' as const, mimeType: 'image/png' },
    { type: 'blob' as const, mimeType: 'image/png', data: '!' },
  ]) {
    const h = harness();
    const frontend = await activate(h.context);
    const node: RenderNode = { kind: 'attachment', origin: { sessionId: 'fixture', messageId: 'omitted' },
      label: 'Unavailable image', attachment };
    const renderer = frontend.chatRenderers![0]!;
    assert.equal(renderer.matches(node), true);
    const renderNode = renderer.component as unknown as (props: { node: RenderNode }) => Element;
    const render = () => {
      h.resetHooks();
      const element = renderNode({ node });
      return typeof element.type === 'function' ? element.type(element.props) : element;
    };
    render(); h.flushEffects();
    const tree = render();
    assert.match(JSON.stringify(tree), /附件不可用/);
    assert.equal(tree.props['aria-busy'], false);
    assert.equal(descendants(tree).some(element => ['a', 'img', 'video', 'audio'].includes(String(element.type))), false);
    assert.equal(h.calls.length, 0);
    h.unmount();
    frontend.dispose?.();
  }
});

test('blob preview waiting is bounded across rerenders and stale media events cannot finish a retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
  const h = harness();
  const frontend = await activate(h.context);
  const renderNode = frontend.chatRenderers![0]!.component as unknown as (props: { node: RenderNode }) => Element;
  const node: RenderNode = {
    kind: 'attachment', origin: { sessionId: 'fixture', messageId: 'image' }, label: 'Native image',
    attachment: { type: 'blob', mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZAAAAABJRU5ErkJggg==' },
  };
  const render = () => {
    h.resetHooks();
    const element = renderNode({ node });
    return typeof element.type === 'function' ? element.type(element.props) : element;
  };
  render(); h.flushEffects();
  const first = render();
  const firstImage = descendants(first).find(element => element.type === 'img')!;
  assert.equal(first.props['aria-busy'], true);
  t.mock.timers.tick(4_000);
  render(); h.flushEffects();
  t.mock.timers.tick(1_001);
  const expired = render();
  assert.equal(expired.props['aria-busy'], false);
  assert.match(JSON.stringify(expired), /预览加载超时/);
  assert.ok(descendants(expired).some(element => element.type === 'a'), 'original remains downloadable');
  (descendants(expired).find(element => element.type === 'button')!.props.onClick as () => void)();
  render(); h.flushEffects();
  (firstImage.props.onLoad as () => void)();
  const retrying = render();
  assert.equal(retrying.props['aria-busy'], true, 'old image cannot complete the new resource');
  const nextImage = descendants(retrying).find(element => element.type === 'img')!;
  assert.notEqual(nextImage.props.src, firstImage.props.src);
  (nextImage.props.onLoad as () => void)();
  assert.equal(render().props['aria-busy'], false);
  h.unmount();
  frontend.dispose?.();
});

test('renderers match only managed native attachments and local Markdown references', async () => {
  const { context, calls } = harness();
  const frontend = await activate(context);
  const renderer = frontend.chatRenderers![0]!;
  const origin = { sessionId: 'session', messageId: 'message', agentId: 'worker' };
  const base: RenderNode = { kind: 'link', label: '<script>safe text</script>', origin, target: './雪%20space.png#part' };
  assert.equal(renderer.matches(base), true);
  assert.equal(renderer.matches({ ...base, kind: 'image' }), true);
  for (const target of ['https://example.test/a.png', 'javascript:alert(1)', 'data:text/html,hello', '#heading', '//other/file']) {
    assert.equal(renderer.matches({ ...base, target }), false);
  }
  assert.equal(renderer.matches({ ...base, kind: 'attachment', attachment: { type: 'file', path: `/data/files/${fileId}/ready/body.png` } }), true);
  assert.equal(renderer.matches({ ...base, kind: 'attachment', attachment: { type: 'file', path: `/data/files/${fileId}/identity.json` } }), false);
  assert.equal(renderer.matches({ ...base, kind: 'attachment', attachment: { type: 'file', path: '/home/report.pdf' } }), false);
  assert.equal(renderer.matches({ ...base, kind: 'attachment', attachment: { type: 'directory', path: `/data/files/${fileId}` } }), false);
  const render = renderer.component as unknown as (props: { node: RenderNode }) => Element;
  const a = render({ node: base });
  const b = render({ node: { ...base, origin: { ...origin, agentId: 'different-display-alias' } } });
  assert.equal(a.type, b.type, 'component definitions stay stable across message deltas');
  assert.equal(a.props.url, b.props.url);
  assert.equal(a.props.name, base.label, 'display text is not interpreted as HTML');
  assert.equal(calls.length, 0, 'rendering URLs never POSTs capture');
  frontend.dispose?.();
});

test('the file picker captures its original draft before a session-changing rerender', async () => {
  const h = harness();
  const frontend = await activate(h.context) as ModuleFrontend;
  const blocks: string[] = [];
  const draft = (sessionId: string): ModuleDraft => ({
    sessionId,
    getSnapshot: () => ({ text: '', attachments: [], pending: false }),
    subscribe: () => () => {},
    appendAttachments: () => {},
    removeAttachment: () => {},
    editText: () => {},
    block: () => { blocks.push(sessionId); return () => {}; },
  });
  const original: ComposerContext = { draft: draft('original'), disabled: false, operation: 'prompt' };
  const next: ComposerContext = { ...original, draft: draft('next') };
  const render = frontend.composerActions![0]!.component as unknown as (context: ComposerContext) => Element;
  const first = render(original);
  let clicked = 0;
  h.refs[0]!.current = { click: () => clicked++ };
  (children(first)[0]!.props.onClick as () => void)();
  assert.equal(clicked, 1, 'the picker opens in the button click stack');
  h.resetHooks();
  const rerender = render(next);
  const input = children(rerender)[1]!;
  const file = new File(['content'], 'a.txt');
  const target = { files: [file], value: 'selected' };
  (input.props.onChange as (event: unknown) => void)({ currentTarget: target });
  assert.equal(target.value, '');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.init!.body, file);
  assert.deepEqual(blocks, ['original']);
  frontend.dispose?.();
});

test('composerAbove preserves native attachment visibility and reports rejected removals', async () => {
  const { context, errors } = harness();
  const frontend = await activate(context);
  const draft: ModuleDraft = {
    sessionId: 'session',
    getSnapshot: () => ({
      text: '', pending: false,
      attachments: [
        { id: 'restored', value: { type: 'file', path: `/data/files/${fileId}/ready/body.pdf`, displayName: 'Restored report' } },
        { id: 'external', value: { type: 'file', path: '/home/native.txt', displayName: 'Native file' } },
        { id: 'directory', value: { type: 'directory', path: '/home/project', displayName: 'Project directory' } },
      ],
    }),
    subscribe: () => () => {},
    appendAttachments: () => {},
    removeAttachment: id => {
      if (id === 'external') throw new Error('Attachment belongs to another module');
    },
    editText: () => {},
    block: () => () => {},
  };
  const render = frontend.composerAbove![0]!.component as unknown as (props: ComposerContext) => Element;
  const tree = render({ draft, operation: 'prompt', disabled: false });
  const rendered = JSON.stringify(tree);
  for (const name of ['Restored report', 'Native file', 'Project directory']) {
    assert.ok(rendered.includes(name), `${name} must not disappear behind the module's composerAbove contribution`);
  }
  assert.doesNotMatch(rendered, /\/home\/native|\/home\/project/);
  const rows = children(tree)[1]!.props.children as [Element[], Element[]];
  const externalRow = rows[0][1]!;
  (children(externalRow)[1]!.props.onClick as () => void)();
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /belongs to another module/);
  assert.equal(draft.getSnapshot().attachments.length, 3);
  frontend.dispose?.();
});
