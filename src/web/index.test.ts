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
  .replaceAll("'./file-state.ts'", JSON.stringify(new URL('./file-state.ts', import.meta.url).href));
const { activate } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`) as { activate: ActivateFrontend };
const fileId = `f_${'a'.repeat(64)}`;
const apiBase = `https://host.test/cockpit/_modules/cockpit-file/${'b'.repeat(64)}/api`;

interface Element {
  type: string | ((props: Record<string, unknown>) => Element);
  props: Record<string, unknown>;
}

function harness() {
  let refIndex = 0;
  const refs: { current: unknown }[] = [];
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
  return { context, refs, calls, errors, signal, resetHooks: () => { refIndex = 0; } };
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
  assert.doesNotMatch(compiled, /(?:from\s*['"]react|react\/jsx-runtime|createRoot|innerHTML|sessionStore)/);
  signal.abort();
  assert.equal(frontend.fileInput![0]!.accepts([new File(['a'], 'a')]), false);
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
