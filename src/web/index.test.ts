import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import type {
  ActivateFrontend, ComposerContext, DraftAttachment, ModuleDraft, ModuleDraftSnapshot,
  ModuleFrontend, ModuleFrontendContext, RenderNode,
} from '@cockpit/module-api';

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
const syntheticPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZAAAAABJRU5ErkJggg==';
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

class Draft implements ModuleDraft {
  sessionId = 'synthetic-session';
  snapshot: ModuleDraftSnapshot = { text: '', attachments: [], pending: false };
  listeners = new Set<() => void>();
  blocks = 0;
  getSnapshot() { return this.snapshot; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  appendAttachments(items: readonly DraftAttachment[]) {
    const ids = new Set(items.map(item => item.id));
    this.snapshot = { ...this.snapshot, attachments: [...this.snapshot.attachments.filter(item => !ids.has(item.id)), ...items] };
    for (const listener of this.listeners) listener();
  }
  removeAttachment(id: string) {
    this.snapshot = { ...this.snapshot, attachments: this.snapshot.attachments.filter(item => item.id !== id) };
    for (const listener of this.listeners) listener();
  }
  editText(text: string) { this.snapshot = { ...this.snapshot, text }; }
  block() { this.blocks++; return () => { this.blocks--; }; }
}

interface Element {
  type: string | symbol | ((props: Record<string, unknown>) => Element);
  props: Record<string, unknown>;
}

function harness() {
  function frame() {
    return {
      refs: [] as { current: unknown }[], states: new Map<number, unknown>(),
      effects: [] as { deps: readonly unknown[]; cleanup?: () => void }[],
      refIndex: 0, stateIndex: 0, effectIndex: 0,
    };
  }
  const root = frame();
  let current = root;
  const frames = new Map<string, ReturnType<typeof frame>>();
  const componentIds = new Map<Element['type'], number>();
  const reset = () => { current.refIndex = 0; current.stateIndex = 0; current.effectIndex = 0; };
  const cleanup = (value: ReturnType<typeof frame>) => {
    for (const effect of value.effects.splice(0)) effect.cleanup?.();
    value.states.clear();
    value.refs.splice(0);
  };
  const pendingEffects: (() => void)[] = [];
  const calls: { path: string; init?: RequestInit }[] = [];
  const signal = new AbortController();
  const errors: unknown[] = [];
  const react = {
    Fragment: Symbol('Fragment'),
    createElement(type: Element['type'], props: Element['props'] | null, ...children: unknown[]): Element {
      return { type, props: { ...props, children } };
    },
    useRef(initial: unknown) {
      const index = current.refIndex++;
      return current.refs[index] ??= { current: initial };
    },
    useCallback<T>(callback: T, deps: readonly unknown[]) {
      const ref = react.useRef(undefined) as { current: { callback: T; deps: readonly unknown[] } | undefined };
      if (!ref.current || !ref.current.deps.every((value, at) => Object.is(value, deps[at]))) ref.current = { callback, deps };
      return ref.current.callback;
    },
    useSyncExternalStore(subscribe: (listener: () => void) => () => void, snapshot: () => unknown) {
      react.useEffect(() => subscribe(() => {}), [subscribe]);
      return snapshot();
    },
    useState(initial?: unknown) {
      const { states } = current;
      const index = current.stateIndex++;
      if (!states.has(index)) states.set(index, initial);
      return [states.get(index), (value: unknown) => {
        states.set(index, typeof value === 'function' ? value(states.get(index)) : value);
      }];
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const { effects } = current;
      const index = current.effectIndex++;
      const previous = effects[index];
      if (previous && previous.deps.every((value, at) => Object.is(value, deps[at]))) return;
      const entry = { deps, cleanup: undefined as (() => void) | undefined };
      effects[index] = entry;
      pendingEffects.push(() => {
        previous?.cleanup?.();
        if (effects[index] === entry) entry.cleanup = effect() || undefined;
      });
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
  return { context, refs: root.refs, calls, errors, signal,
    resetHooks: () => { current = root; reset(); },
    render(component: unknown, props: unknown): Element {
      const seen = new Set<string>();
      function visit(value: unknown, path: string): unknown {
        if (Array.isArray(value)) return value.map((child, index) => visit(child,
          `${path}/${child && typeof child === 'object' && 'props' in child && (child as Element).props.key || index}`));
        if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return value;
        const element = value as Element;
        if (typeof element.type === 'function') {
          if (!componentIds.has(element.type)) componentIds.set(element.type, componentIds.size);
          const id = `${path}/component-${componentIds.get(element.type)}`;
          seen.add(id);
          if (!frames.has(id)) frames.set(id, frame());
          current = frames.get(id)!;
          reset();
          return visit(element.type(element.props), id);
        }
        return { ...element, props: { ...element.props, children: visit(element.props.children, `${path}/children`) } };
      }
      const result = visit({ type: component, props }, 'root');
      for (const [id, value] of frames) if (!seen.has(id)) { cleanup(value); frames.delete(id); }
      current = root;
      return result as Element;
    },
    flushEffects: () => { for (const effect of pendingEffects.splice(0)) effect(); },
    unmount: () => {
      cleanup(root);
      for (const value of frames.values()) cleanup(value);
      frames.clear();
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
  assert.equal(frontend.rendersDraftAttachments, true);
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
  const render = () => h.render(renderNode, { node });
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
    const render = () => h.render(renderNode, { node });
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
      data: syntheticPng },
  };
  const render = () => h.render(renderNode, { node });
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
  (descendants(expired).find(element => element.props['aria-label'] === '重新加载 Native image')!.props.onClick as () => void)();
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
  const h = harness();
  const { context, errors } = h;
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
  const tree = h.render(render, { draft, operation: 'prompt', disabled: false });
  const rendered = JSON.stringify(tree);
  for (const name of ['Restored report', 'Native file', 'Project directory']) {
    assert.ok(rendered.includes(name), `${name} must not disappear behind the module's composerAbove contribution`);
  }
  assert.doesNotMatch(rendered, /\/home\/native|\/home\/project/);
  const remove = descendants(tree).find(element => element.props['aria-label'] === '移除 Native file')!;
  (remove.props.onClick as () => void)();
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /belongs to another module/);
  assert.equal(draft.getSnapshot().attachments.length, 3);
  frontend.dispose?.();
});

test('attachment action is an accessible borderless icon, not a boxed label', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const draft = new Draft();
  const tree = h.render(frontend.composerActions![0]!.component, { draft, operation: 'prompt', disabled: false });
  const button = descendants(tree).find(element => element.type === 'button')!;
  assert.equal(button.props.className, 'cf-upload-button');
  assert.equal(button.props['aria-label'], '添加文件');
  assert.match(String(button.props.title), /添加文件/);
  const icon = descendants(button).find(element => element.type === 'svg')!;
  assert.equal(icon.props.width, '22');
  assert.equal(icon.props.height, '22');
  assert.equal(icon.props.strokeWidth, '1.5');
  assert.equal(icon.props.strokeLinecap, 'round');
  assert.equal(icon.props.strokeLinejoin, 'round');
  assert.equal(descendants(button).some(element => element.type === 'span'), false);
  const disabled = h.render(frontend.composerActions![0]!.component, { draft, operation: 'ask', disabled: false });
  assert.equal(descendants(disabled).find(element => element.type === 'button')!.props.disabled, true);
  frontend.dispose?.();
});

test('each selection has its own thumbnail, honest progress, inline failure and remove/retry actions', async () => {
  const h = harness();
  const responses: ((response: Response) => void)[] = [];
  h.context.request = (path, init) => {
    h.calls.push({ path, init });
    return new Promise(resolve => responses.push(resolve));
  };
  const frontend = await activate(h.context);
  const draft = new Draft();
  const composer: ComposerContext = { draft, operation: 'prompt', disabled: false };
  const file = new File([Buffer.from(syntheticPng, 'base64')], '同名-很长的图片-'.repeat(12) + '.png', { type: 'image/png' });
  frontend.fileInput![0]!.receive([file, file], composer);
  const render = () => h.render(frontend.composerAbove![0]!.component, composer);
  render(); h.flushEffects();
  let tree = render();
  let images = descendants(tree).filter(element => element.type === 'img');
  assert.equal(images.length, 2);
  assert.notEqual(images[0]!.props.src, images[1]!.props.src);
  const originalUrls = images.map(image => String(image.props.src));
  assert.equal((await (await fetch(originalUrls[0]!)).blob()).size, file.size);
  for (const image of images) (image.props.onLoad as () => void)();
  const cards = descendants(tree).filter(element => element.props.className === 'cf-card');
  assert.equal(cards.length, 2);
  assert.ok(cards.every(card => card.props['aria-busy'] === true));
  const progress = descendants(tree).filter(element => element.type === 'progress');
  assert.equal(progress.length, 2);
  assert.ok(progress.every(element => element.props.value === undefined && element.props.max === undefined));
  assert.doesNotMatch(JSON.stringify(tree), /请等待|后发送|当前操作不接受/);
  assert.equal(descendants(tree).filter(element => element.type === 'p').length, 0, 'no bottom notice or normal-upload banner');
  const remove = descendants(cards[0]).find(element => element.props['aria-label'] === `移除 ${file.name}`)!;
  (remove.props.onClick as () => void)();
  tree = render(); h.flushEffects();
  await assert.rejects(fetch(originalUrls[0]!));
  assert.equal(draft.blocks, 1, 'another pending item still blocks every host send entry point');
  assert.equal(h.calls[2]!.init!.method, 'DELETE');
  responses[2]!(new Response(null, { status: 204 }));
  responses[0]!(Response.json({
    fileId, attachment: { type: 'file', path: `/data/files/${fileId}/ready/body.png`, displayName: file.name },
  }));
  responses[1]!(Response.json({ error: 'Synthetic network failure' }, { status: 503 }));
  await settle();
  tree = render(); h.flushEffects();
  assert.equal(draft.snapshot.attachments.length, 0, 'late success of a removed item is ignored');
  assert.match(JSON.stringify(tree), /Synthetic network failure/);
  assert.equal(descendants(tree).filter(element => element.type === 'progress').length, 0);
  assert.equal(descendants(tree).filter(element => element.props.role === 'alert').length, 1);
  const retry = descendants(tree).find(element => element.props['aria-label'] === `重新上传 ${file.name}`)!;
  (retry.props.onClick as () => void)();
  assert.equal(h.calls[3]!.path, h.calls[1]!.path);
  assert.equal(h.calls[3]!.init!.body, file);
  assert.equal(descendants(render()).filter(element => element.type === 'progress').length, 1);
  responses[3]!(Response.json({
    fileId, attachment: { type: 'file', path: `/data/files/${fileId}/ready/body.png`, displayName: file.name },
  }));
  await settle();
  render(); h.flushEffects();
  assert.equal(draft.blocks, 0);
  assert.equal(draft.snapshot.attachments.length, 1);
  await assert.rejects(fetch(originalUrls[1]!));
  assert.equal(h.calls[4]!.init!.method, 'HEAD');
  responses[4]!(new Response(null, { headers: { 'content-type': 'image/png', 'content-length': `${file.size}` } }));
  await settle();
  tree = render();
  images = descendants(tree).filter(element => element.type === 'img');
  assert.equal(images.length, 1);
  assert.equal(images[0]!.props.src, `${apiBase}/files/${fileId}/body.png`);
  (images[0]!.props.onLoad as () => void)();
  tree = render();
  assert.equal(descendants(tree).filter(element => element.props.className === 'cf-card').length, 1);
  assert.equal(descendants(tree).some(element => element.type === 'progress'), false);
  assert.equal(descendants(tree).some(element => element.type === 'a'), false, 'draft actions are not duplicate chat downloads');
  h.unmount();
  frontend.dispose?.();
});

test('send pending disables upload, picker, ready removal, pending removal and retry until the receipt', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const draft = new Draft();
  draft.appendAttachments([{ id: 'restored', value: { type: 'directory', path: '/fixture', displayName: 'Ready' } }]);
  const composer: ComposerContext = { draft, disabled: false, operation: 'prompt' };
  frontend.fileInput![0]!.receive([new File(['pending'], 'Uploading')], composer);
  frontend.fileInput![0]!.receive([new File([new Uint8Array(100_001)], 'Failed')], composer);
  const render = () => {
    const action = h.render(frontend.composerActions![0]!.component, composer);
    const rows = h.render(frontend.composerAbove![0]!.component, composer);
    return [...descendants(action), ...descendants(rows)];
  };
  const unlocked = render();
  assert.ok(unlocked.some(element => element.props['aria-label'] === '重新上传 Failed'));
  draft.snapshot = { ...draft.snapshot, pending: true };
  const locked = render();
  for (const label of ['添加文件', '选择文件', '移除 Ready', '移除 Uploading', '移除 Failed', '重新上传 Failed']) {
    assert.equal(locked.find(element => element.props['aria-label'] === label)!.props.disabled, true, label);
  }
  draft.snapshot = { ...draft.snapshot, pending: false };
  for (const element of render().filter(element => element.type === 'button' && /添加文件|移除|重新上传/.test(String(element.props['aria-label'])))) {
    assert.equal(!!element.props.disabled, false);
  }
  assert.ok(unlocked.some(element => element.type === 'input'));
  h.unmount();
  frontend.dispose?.();
});

test('a file picker opened before sending cannot upload its late selection during pending', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const draft = new Draft();
  const composer: ComposerContext = { draft, operation: 'prompt', disabled: false };
  const tree = h.render(frontend.composerActions![0]!.component, composer);
  const button = descendants(tree).find(element => element.type === 'button')!;
  const input = descendants(tree).find(element => element.type === 'input')!;
  (button.props.onClick as () => void)();
  draft.snapshot = { ...draft.snapshot, pending: true };
  const target = { files: [new File(['late'], 'late.txt')], value: 'selected' };
  (input.props.onChange as (event: unknown) => void)({ currentTarget: target });
  assert.equal(target.value, '');
  assert.equal(h.calls.length, 0);
  assert.equal(draft.blocks, 0);
  assert.match(String(h.errors[0]), /正在提交/);
  h.unmount();
  frontend.dispose?.();
});
test('selection thumbnail URLs release on view unmount and module stop without cancelling a switched-away draft', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const draft = new Draft();
  const composer: ComposerContext = { draft, operation: 'prompt', disabled: false };
  frontend.fileInput![0]!.receive([new File([Buffer.from(syntheticPng, 'base64')], 'pixel.png', { type: 'image/png' })], composer);
  const render = () => h.render(frontend.composerAbove![0]!.component, composer);
  render(); h.flushEffects();
  const first = String(descendants(render()).find(element => element.type === 'img')!.props.src);
  h.unmount();
  await assert.rejects(fetch(first));
  assert.equal(draft.blocks, 1);
  assert.equal(h.calls[0]!.init!.signal!.aborted, false);
  render(); h.flushEffects();
  const second = String(descendants(render()).find(element => element.type === 'img')!.props.src);
  assert.notEqual(second, first);
  h.signal.abort();
  await assert.rejects(fetch(second));
  assert.equal(h.calls[0]!.init!.signal!.aborted, true);
  assert.equal(draft.blocks, 0);
  assert.equal(h.calls.length, 1, 'teardown does not delete originals');
  h.unmount();
});

test('restored draft images and chat use the same compact skeleton and canonical URL, never a managed-file Blob', async () => {
  const h = harness();
  h.context.request = async (path, init) => {
    h.calls.push({ path, init });
    return new Response(null, { headers: { 'content-type': 'image/png', 'content-length': '68' } });
  };
  const frontend = await activate(h.context);
  const draft = new Draft();
  const attachment = { type: 'file' as const, path: `/data/files/${fileId}/ready/body.png`, displayName: 'Restored pixel' };
  draft.appendAttachments([{ id: 'restored', value: attachment }]);
  const composer: ComposerContext = { draft, operation: 'prompt', disabled: false };
  const component = frontend.composerAbove![0]!.component;
  h.render(component, composer); h.flushEffects(); await settle();
  const draftTree = h.render(component, composer);
  const card = descendants(draftTree).find(element => element.props.className === 'cf-card')!;
  const image = descendants(card).find(element => element.type === 'img')!;
  assert.equal(image.props.src, `${apiBase}/files/${fileId}/body.png`);
  (image.props.onLoad as () => void)();
  const node: RenderNode = { kind: 'attachment', origin: { sessionId: 'fixture', messageId: 'restored' }, label: attachment.displayName, attachment };
  const chat = h.render(frontend.chatRenderers![0]!.component, { node });
  h.flushEffects();
  assert.equal(chat.props.className, card.props.className);
  assert.equal(descendants(chat).find(element => element.type === 'img')!.props.src, image.props.src);
  assert.equal(descendants(chat).find(element => element.type === 'a')!.props.href, `${image.props.src}?download=1`);
  assert.ok(h.calls.every(call => call.init!.method === 'HEAD'));
  assert.equal(h.calls.length, 1, 'mounted consumers share the same five-second probe round');
  assert.doesNotMatch(source, /response\.blob\(|fetch\(|createRoot|sessionStorage|sendPrompt|\.submit\(/);
  h.unmount();
  frontend.dispose?.();
});

test('a thumbnail opens an explicitly closable native dialog and a changed resource closes it', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  let node: RenderNode = { kind: 'attachment', origin: { sessionId: 'fixture', messageId: 'preview' }, label: 'Synthetic pixel',
    attachment: { type: 'blob', mimeType: 'image/png', data: syntheticPng } };
  const render = () => h.render(frontend.chatRenderers![0]!.component, { node });
  render(); h.flushEffects();
  let tree = render();
  assert.equal(descendants(tree).some(element => element.type === 'dialog'), false);
  const thumbnail = descendants(tree).find(element => element.props['aria-haspopup'] === 'dialog')!;
  assert.equal(thumbnail.props['aria-label'], '查看 Synthetic pixel');
  (thumbnail.props.onClick as () => void)();
  tree = render();
  let dialog = descendants(tree).find(element => element.type === 'dialog')!;
  assert.equal(dialog.props['aria-label'], '预览 Synthetic pixel');
  let shown = 0, closed = 0;
  const attachDialog = () => {
    const element = dialog;
    (element.props.ref as { current: unknown }).current = {
      showModal: () => shown++,
      close: () => { closed++; (element.props.onClose as () => void)(); },
    };
    h.flushEffects();
  };
  attachDialog();
  assert.equal(shown, 1, 'showModal gives native focus trapping, Escape and return-focus behavior');
  const close = descendants(dialog).find(element => element.type === 'button')!;
  assert.equal(close.props.autoFocus, true);
  (close.props.onClick as () => void)();
  assert.equal(closed, 1);
  tree = render(); h.flushEffects();
  assert.equal(descendants(tree).some(element => element.type === 'dialog'), false);
  (descendants(tree).find(element => element.props['aria-haspopup'] === 'dialog')!.props.onClick as () => void)();
  tree = render();
  dialog = descendants(tree).find(element => element.type === 'dialog')!;
  attachDialog();
  const staleImage = descendants(tree).find(element => element.type === 'img')!;
  node = { ...node, attachment: { type: 'blob', mimeType: 'image/svg+xml',
    data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="blue"/></svg>').toString('base64') } };
  render(); h.flushEffects();
  (staleImage.props.onLoad as () => void)();
  tree = render();
  assert.equal(tree.props['aria-busy'], true, 'an old image cannot finish a different resource');
  assert.equal(descendants(tree).some(element => element.type === 'dialog'), false);
  assert.ok(closed >= 2);
  h.unmount();
  frontend.dispose?.();
});

test('audio/video controls stay behind an explicit play action and unsafe document types stay download-only', async () => {
  for (const mimeType of ['audio/wav', 'video/mp4', 'application/pdf', 'text/html']) {
    const h = harness();
    const frontend = await activate(h.context);
    const node: RenderNode = { kind: 'attachment', origin: { sessionId: 'fixture', messageId: mimeType }, label: 'Synthetic media',
      attachment: { type: 'blob', mimeType, data: 'c3ludGhldGlj' } };
    const render = () => h.render(frontend.chatRenderers![0]!.component, { node });
    render(); h.flushEffects();
    let tree = render();
    assert.equal(descendants(tree).some(element => ['iframe', 'object', 'embed', 'dialog'].includes(String(element.type))), false);
    assert.equal(descendants(tree).some(element => element.props.controls), false);
    const play = descendants(tree).find(element => element.props['aria-label'] === '播放 Synthetic media');
    if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
      assert.ok(play);
      (play.props.onClick as () => void)();
      tree = render();
      const players = descendants(tree).filter(element => element.props.controls === true);
      assert.equal(players.length, 1);
      (players[0]!.props.onLoadedMetadata as () => void)();
      assert.equal(render().props['aria-busy'], false);
      (players[0]!.props.onError as () => void)();
      tree = render();
      assert.match(JSON.stringify(tree), /无法预览/);
      assert.equal(descendants(tree).some(element => element.type === 'dialog'), false);
      assert.ok(descendants(tree).some(element => element.type === 'a'), 'a failed expanded player keeps the original download');
    } else {
      assert.equal(play, undefined);
      assert.equal(descendants(tree).some(element => ['img', 'audio', 'video'].includes(String(element.type))), false);
      assert.ok(descendants(tree).some(element => element.type === 'a'));
    }
    h.unmount();
    frontend.dispose?.();
  }
});

test('compact styles are module-scoped, wrap multiple files and constrain long filenames', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.cf-upload-button\s*\{[^}]*width:\s*2\.5rem;[^}]*height:\s*2\.5rem;[^}]*border:\s*0;[^}]*border-radius:\s*50%;[^}]*background:\s*transparent;/s);
  assert.match(css, /box-shadow:\s*inset 0 0 0 1px/);
  assert.match(css, /\.cf-card\s*\{[^}]*grid-template-columns:\s*3rem minmax\(0, 1fr\) 4rem;[^}]*width:\s*17\.5rem;[^}]*max-width:\s*100%;[^}]*height:\s*4\.5rem;/s);
  assert.match(css, /\.cf-attachment\s*\{[^}]*flex:\s*0 0 auto;[^}]*width:\s*17\.5rem;/s);
  assert.match(css, /\.cf-thumbnail\s*\{[^}]*width:\s*3rem;[^}]*height:\s*3rem;/s);
  assert.match(css, /\.cf-thumbnail\s*\{[^}]*grid-template:\s*minmax\(0, 1fr\) \/ minmax\(0, 1fr\);/s);
  assert.match(css, /\.cf-name-stem\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s);
  assert.match(css, /\.cf-name-extension\s*\{[^}]*max-width:\s*45%;/s);
  assert.match(css, /\.cf-card-details\s*\{[^}]*grid-template-rows:\s*1\.25rem 1\.125rem 0\.25rem;/s);
  assert.match(css, /\.cf-card-actions\s*\{[^}]*justify-content:\s*flex-end;[^}]*width:\s*4rem;/s);
  assert.match(css, /\.cf-media\s*\{[^}]*object-fit:\s*contain;/s);
  assert.match(css, /\.cf-attachment-list\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.doesNotMatch(css, /22rem|11rem|\b(?:body|html|:root)\b|\.chat-|line-clamp/);
  const selectors = [...css.matchAll(/(?:^|})\s*([^{}]+)\{/g)].flatMap(match => match[1]!.split(','));
  assert.ok(selectors.every(selector => selector.trim().startsWith('.cf-')), 'no global host CSS overrides');
});

test('full names and errors are accessible on touch while all tile information and actions use fixed slots', async () => {
  for (const name of ['项目说明'.repeat(80) + '.png', 'a'.repeat(300) + '.tar.gz', 'x.' + 'b'.repeat(300), '.gitignore', '🖼️ صورة طويلة.png', 'no-extension']) {
    const h = harness();
    const frontend = await activate(h.context);
    const draft = new Draft();
    const composer: ComposerContext = { draft, disabled: false, operation: 'prompt' };
    frontend.fileInput![0]!.receive([new File([new Uint8Array(100_001)], name)], composer);
    const render = () => h.render(frontend.composerAbove![0]!.component, composer);
    let tree = render();
    const card = descendants(tree).find(element => element.props.className === 'cf-card')!;
    const slots = children(card);
    assert.equal(slots[1]!.props.className, 'cf-card-details');
    assert.equal(slots[2]!.props.className, 'cf-card-actions');
    assert.equal(descendants(slots[2]).filter(element => element.type === 'button').length, 2);
    assert.equal(descendants(slots[1]).some(element => /移除|重新上传/.test(String(element.props['aria-label']))), false);
    const nameButton = descendants(card).find(element => element.props.className === 'cf-card-name')!;
    assert.equal(nameButton.type, 'button');
    assert.equal(nameButton.props.title, name);
    const stem = descendants(nameButton).find(element => element.props.className === 'cf-name-stem')!;
    const extension = descendants(nameButton).find(element => element.props.className === 'cf-name-extension');
    assert.equal((stem.props.children as string[]).join('') + (extension?.props.children as string[] ?? []).join(''), name);
    assert.equal(extension !== undefined, name.endsWith('.png') || name.endsWith('.tar.gz'));
    (nameButton.props.onClick as () => void)();
    tree = render();
    const dialog = descendants(tree).find(element => element.type === 'dialog')!;
    assert.equal(dialog.props['aria-label'], `文件详情 ${name}`);
    assert.deepEqual(descendants(dialog).find(element => element.props.className === 'cf-dialog-name')!.props.children, [name]);
    assert.match(JSON.stringify(dialog), /upload limit/);
    assert.equal(descendants(dialog).some(element => ['img', 'video', 'iframe', 'object'].includes(String(element.type))), false);
    (dialog.props.onClose as () => void)();
    tree = render();
    const errorButton = descendants(tree).find(element => String(element.props['aria-label']).startsWith('查看文件错误：'))!;
    (errorButton.props.onClick as () => void)();
    assert.ok(descendants(render()).some(element => element.type === 'dialog'));
    h.unmount();
    frontend.dispose?.();
  }
});
