import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { icons } from './icons.ts';
import type {
  ActivateFrontend, AttachmentProps, ComposerEditorProps, ComposerProps, ComposerTarget,
  DraftPurpose, DraftReference, DraftSchemaScope, HostSnapshot, MarkdownNode, MarkdownRendererProps, ModuleDraft, ModuleDraftSnapshot,
  ModuleFrontend, ModuleFrontendContext, ModuleStateRegistry,
} from '@cockpit/module-api';
import type { ClipboardEvent, ComponentType, DragEvent } from 'react';
import { fileDraftSchema, type FileAttachment, type FileState } from './file-draft.ts';

const source = await readFile(new URL('./index.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React },
}).outputText
  .replaceAll("'../shared/files.ts'", JSON.stringify(new URL('../shared/files.ts', import.meta.url).href))
  .replaceAll("'./file-state.ts'", JSON.stringify(new URL('./file-state.ts', import.meta.url).href))
  .replaceAll("'./file-draft.ts'", JSON.stringify(new URL('./file-draft.ts', import.meta.url).href))
  .replaceAll("'./file-input.ts'", JSON.stringify(new URL('./file-input.ts', import.meta.url).href))
  .replaceAll("'./file-services.ts'", JSON.stringify(new URL('./file-services.ts', import.meta.url).href))
  .replaceAll("'./icons.ts'", JSON.stringify(new URL('./icons.ts', import.meta.url).href))
  .replaceAll("'./blob.ts'", JSON.stringify(new URL('./blob.ts', import.meta.url).href));
const { activate: activateModule } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`) as { activate: ActivateFrontend };
const registries = new WeakMap<ModuleStateRegistry, () => void>();
const contexts = new WeakMap<ModuleFrontend, ModuleFrontendContext>();
async function activate(context: ModuleFrontendContext) {
  try {
    const frontend = await activateModule(context);
    const dispose = () => { frontend.dispose?.(); registries.get(context.state)?.(); };
    context.signal.addEventListener('abort', dispose, { once: true });
    const loaded = { ...frontend, dispose };
    contexts.set(loaded, context);
    return loaded;
  } catch (error) {
    registries.get(context.state)?.();
    throw error;
  }
}

const fileId = `f_${'a'.repeat(64)}`;
const apiBase = `https://host.test/cockpit/_modules/cockpit-file/${'b'.repeat(64)}/api`;
const syntheticPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZAAAAABJRU5ErkJggg==';
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const body = {};
class NativeInput extends EventTarget {
  type = '';
  multiple = false;
  files: readonly File[] = [];
  value = '';
  clicks = 0;
  click() { this.clicks++; }
}
const nativeInputs: NativeInput[] = [];
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  body, visibilityState: 'visible', addEventListener() {}, removeEventListener() {},
  createElement(tag: string) {
    assert.equal(tag, 'input');
    const input = new NativeInput();
    nativeInputs.push(input);
    return input;
  },
} });

const bindings = new WeakMap<DraftReference, ModuleDraft>();
const preparers = new Set<(draft: Draft) => void>();
const fileScopes = new WeakMap<DraftReference, DraftSchemaScope<FileState>>();
class Draft implements ModuleDraft {
  readonly id = crypto.randomUUID();
  readonly sessionId: string;
  readonly purpose: DraftPurpose;
  readonly reference: DraftReference;
  snapshot: ModuleDraftSnapshot = { text: '', blocks: [], hasContent: false, revision: 0, pending: false, unconfirmed: false, retired: false };
  listeners = new Set<() => void>();
  blocks = 0;
  constructor(sessionId = 'synthetic-session', purpose: DraftPurpose = { kind: 'prompt' }) {
    this.sessionId = sessionId;
    this.purpose = purpose;
    this.reference = Object.freeze({
      id: this.id, sessionId, purpose, getSnapshot: () => this.getSnapshot(), subscribe: (listener: () => void) => this.subscribe(listener),
    });
    bindings.set(this.reference, this);
    for (const prepare of preparers) prepare(this);
  }
  getSnapshot() { return this.snapshot; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get fileSnapshot() { return fileScopes.get(this.reference)!.getSnapshot(); }
  appendAttachments(items: readonly FileAttachment[]) {
    fileScopes.get(this.reference)!.update(current => {
      const ids = new Set(items.map(item => item.id));
      const revision = current.revision + 1;
      return { revision, attachments: [...current.attachments.filter(item => !ids.has(item.id)), ...items.map(item => ({ ...item, revision }))] };
    });
  }
  removeAttachment(id: string) {
    fileScopes.get(this.reference)!.update(current => ({ ...current, attachments: current.attachments.filter(item => item.id !== id) }));
  }
  editText(text: string) { this.snapshot = { ...this.snapshot, text }; }
  editTextIfRevision(): never { assert.fail('File does not edit conditional text'); }
  captureSend(): never { assert.fail('File does not capture send intents'); }
  block(reason: string) {
    const id = crypto.randomUUID();
    this.blocks++;
    this.snapshot = { ...this.snapshot, blocks: [...this.snapshot.blocks, { id, reason }] };
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.blocks--;
      this.snapshot = { ...this.snapshot, blocks: this.snapshot.blocks.filter(block => block.id !== id) };
    };
  }
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
      return { type, props: { ...props, ...(children.length ? { children } : {}) } };
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
    useMemo<T>(factory: () => T, deps: readonly unknown[]) {
      const ref = react.useRef(undefined) as { current: { value: T; deps: readonly unknown[] } | undefined };
      if (!ref.current || !ref.current.deps.every((value, at) => Object.is(value, deps[at]))) ref.current = { value: factory(), deps };
      return ref.current.value;
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
    useLayoutEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      react.useEffect(effect, deps);
    },
  };
  const services: { id: string; service: object; dispose(): void }[] = [];
  const schemas: { id: string; purposes: readonly string[] }[] = [];
  const schemaDisposers: (() => void)[] = [];
  const disposedServices: string[] = [];
  const hostListeners = new Set<() => void>();
  const boundDrafts = new Set<Draft>();
  let host: HostSnapshot = Object.freeze({ sessionId: 'synthetic-session', visible: true, connected: true });
  let stopped = false;
  const state: ModuleStateRegistry = {
    chatWindow: { getSnapshot() { assert.fail('File does not read chat windows'); }, subscribe() { assert.fail('File does not subscribe to chat windows'); } },
    host: { getSnapshot: () => host, subscribe: listener => { hostListeners.add(listener); return () => hostListeners.delete(listener); } },
    register(registration) {
      assert.equal(schemas.length, 1, 'the file schema registers before services');
      assert.equal(services.some(service => service.id === registration.id), false);
      const service = registration.create();
      services.push({ id: registration.id, service, dispose() { disposedServices.push(registration.id); registration.dispose(service); } });
      return { id: registration.id, get() { if (stopped) throw new Error('Revoked state'); return service; } };
    },
    registerDraft(registration) {
      assert.equal(services.length, 0, 'schema registration is activation-only, before services/render');
      schemas.push(registration);
      const scopes = new Map<DraftReference, DraftSchemaScope<ReturnType<typeof registration.create>>>();
      const prepare = (draft: Draft) => {
        if (!registration.purposes.includes(draft.purpose.kind)) return;
        let snapshot = registration.validate(registration.create(draft.reference));
        const listeners = new Set<() => void>();
        const scope: DraftSchemaScope<typeof snapshot> = {
          draft: draft.reference,
          getSnapshot: () => snapshot,
          subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
          update: change => {
            if (stopped) throw new Error('Revoked schema');
            const next = registration.validate(change(snapshot));
            registration.persistence?.serialize(next);
            snapshot = next;
            draft.snapshot = { ...draft.snapshot, hasContent: !!draft.snapshot.text.trim() || registration.hasContent(next) };
            for (const listener of listeners) listener();
            for (const listener of draft.listeners) listener();
            return snapshot;
          },
        };
        scopes.set(draft.reference, scope);
        fileScopes.set(draft.reference, scope as unknown as DraftSchemaScope<FileState>);
      };
      preparers.add(prepare);
      schemaDisposers.push(() => { preparers.delete(prepare); scopes.clear(); });
      return { id: registration.id, forDraft: reference => {
        if (stopped || !bindings.has(reference)) throw new Error('Foreign or revoked schema reference');
        return scopes.get(reference);
      } };
    },
    bindDraft(reference) {
      assert.equal(stopped, false);
      const draft = bindings.get(reference);
      if (!draft) throw new Error('Foreign draft reference');
      if (draft instanceof Draft) boundDrafts.add(draft);
      return draft;
    },
  };
  registries.set(state, () => {
    if (stopped) return;
    stopped = true;
    for (const service of [...services].reverse()) service.dispose();
    for (const dispose of schemaDisposers) dispose();
    for (const draft of boundDrafts) assert.equal(draft.blocks, 0, 'module loss releases generic leases without file fallback UI');
  });
  const context: ModuleFrontendContext = {
    apiVersion: 2, moduleId: 'cockpit-file', react: react as unknown as ModuleFrontendContext['react'],
    uiVersion: 1,
    uiSurfaceVersion: 1,
    menuVersion: 1, chatWindowVersion: 1, composerInputVersion: 1, draftLifecycleVersion: 1, draftSubmissionVersion: 1,
    createPortal: (node, container) => {
      assert.equal(container, body, 'dialogs use the standard document body, never private host DOM');
      return { type: 'fixture-portal', key: null, children: node, props: { children: [node], container } };
    },
    apiBase, config: { nativePathPrefix: '/data/files/', maxBytes: 100_000 }, state,
    onInvalidate: () => () => {},
    onEvent() { assert.fail('File does not subscribe to module payload events'); },
    signal: signal.signal, report: error => errors.push(error),
    request: async (path, init) => {
      calls.push({ path, init });
      return new Promise(() => {});
    },
  };
  return { context, refs: root.refs, calls, errors, signal, services, schemas, disposedServices, hostListeners,
    setHost(patch: Partial<HostSnapshot>) { host = Object.freeze({ ...host, ...patch }); for (const listener of hostListeners) listener(); },
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

type NativeFixture = {
  kind: 'attachment'; origin: MarkdownNode['origin']; label: string; attachment: AttachmentProps['attachment'];
};
const attachmentComponents = new WeakMap<ModuleFrontend, ComponentType<AttachmentProps>>();
function attachmentComponent(frontend: ModuleFrontend) {
  if (!attachmentComponents.has(frontend)) {
    const React = contexts.get(frontend)!.react;
    const middleware = frontend.components!.find(item => item.boundary === 'attachment')!;
    attachmentComponents.set(frontend, middleware.wrap(props => React.createElement(React.Fragment, null, props.children, props.actions)));
  }
  return attachmentComponents.get(frontend)!;
}
const nativeComponents = new WeakMap<ModuleFrontend, unknown>();
function nativeComponent(frontend: ModuleFrontend) {
  if (!nativeComponents.has(frontend)) {
    const React = contexts.get(frontend)!.react;
    const Attachment = attachmentComponent(frontend);
    nativeComponents.set(frontend, ({ node }: { node: NativeFixture }) => React.createElement(Attachment, {
      origin: node.origin, index: 0, attachment: node.attachment, label: node.label, children: node.label,
    }));
  }
  return nativeComponents.get(frontend);
}
const composerComponents = new WeakMap<ModuleFrontend, ComponentType<ComposerProps>>();
const editorComponents = new WeakMap<ModuleFrontend, ComponentType<ComposerEditorProps>>();
function enhanceEditor(frontend: ModuleFrontend) {
  if (!editorComponents.has(frontend)) {
    const React = contexts.get(frontend)!.react;
    const middleware = frontend.components!.find(item => item.boundary === 'composerEditor')!;
    editorComponents.set(frontend, middleware.wrap(({
      draft, operation: _operation, disabled, busy: _busy, placeholder, submitLabel, sendBlocked,
      statusInHeader: _status, editorRef, children, onTextChange, onSubmit, ...dom
    }) => React.createElement('div', { ...dom, className: 'chat-input' },
      children, React.createElement('textarea', { ref: editorRef, placeholder, disabled,
        value: draft.getSnapshot().text, onChange: event => onTextChange(event.currentTarget.value) }),
      React.createElement('button', { type: 'button', 'aria-label': 'native send', disabled: disabled || sendBlocked,
        onClick: onSubmit }, submitLabel || 'Send'))));
  }
  return editorComponents.get(frontend)!;
}
function enhanceComposer(frontend: ModuleFrontend) {
  if (!composerComponents.has(frontend)) {
    const React = contexts.get(frontend)!.react;
    const middleware = frontend.components!.find(item => item.boundary === 'composer')!;
    const Editor = enhanceEditor(frontend);
    composerComponents.set(frontend, middleware.wrap(props => React.createElement('fixture-composer', {},
      props.children, React.createElement(Editor, { ...props, children: undefined }))));
  }
  return composerComponents.get(frontend)!;
}
function composerProps(frontend: ModuleFrontend, target: ComposerTarget): ComposerProps {
  const draft = target.draft instanceof Draft ? target.draft.reference : target.draft;
  return {
    ...target, draft, busy: false, sendBlocked: false, onTextChange() {}, onSubmit() {},
  };
}
const composerFixtures = new WeakMap<ModuleFrontend, unknown>();
function composerComponent(frontend: ModuleFrontend) {
  if (!composerFixtures.has(frontend)) {
    const React = contexts.get(frontend)!.react;
    const Composer = enhanceComposer(frontend);
    composerFixtures.set(frontend, (target: ComposerTarget) => React.createElement(Composer, composerProps(frontend, target)));
  }
  return composerFixtures.get(frontend);
}
function editorHandlers(frontend: ModuleFrontend, props: ComposerEditorProps) {
  const Enhanced = enhanceEditor(frontend) as (props: ComposerEditorProps) => unknown;
  const element = Enhanced(props) as Element;
  return element.props as unknown as ComposerEditorProps;
}
function fileEvent(files: readonly File[], data: Record<string, string> = {}) {
  const transfer = { files, items: [], types: files.length ? ['Files', ...Object.keys(data)] : Object.keys(data),
    dropEffect: 'none', getData: (type: string) => data[type] || '' };
  return {
    nativeEvent: {}, defaultPrevented: false,
    preventDefault(this: { defaultPrevented: boolean }) { this.defaultPrevented = true; },
    clipboardData: transfer, dataTransfer: transfer,
  } as unknown as ClipboardEvent<HTMLDivElement> & DragEvent<HTMLDivElement>;
}
function selectFiles(frontend: ModuleFrontend, target: ComposerTarget, files: readonly File[]) {
  const props = composerProps(frontend, target);
  const event = fileEvent(files);
  editorHandlers(frontend, props).onPaste?.(event);
  return event.defaultPrevented;
}

test('activation registers scoped concrete services and only v2 component and Markdown boundaries', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  assert.equal(frontend.apiVersion, 2);
  assert.equal(frontend.writes, undefined);
  assert.deepEqual(h.schemas.map(schema => ({ id: schema.id, purposes: schema.purposes })), [{ id: 'attachments', purposes: ['prompt'] }]);
  assert.deepEqual(frontend.components!.map(item => item.boundary), ['composer', 'composerEditor', 'attachment']);
  assert.equal(frontend.markdown!.length, 1);
  assert.deepEqual(Object.keys(frontend).sort(), ['apiVersion', 'components', 'dispose', 'markdown']);
  const ids = [...h.schemas, ...h.services, ...frontend.components!, ...frontend.markdown!].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'state, component and Markdown IDs are unique in one module');
  assert.deepEqual(h.services.map(item => item.id), ['file-drafts', 'view-resources', 'uploads', 'file-probes', 'file-inputs']);
  assert.equal(h.services[2]!.service.constructor.name, 'UploadStore');
  assert.equal(h.services[3]!.service.constructor.name, 'FileProbes');
  assert.equal(h.services[4]!.service.constructor.name, 'FileInputs');
  assert.equal(h.calls.length, 0, 'registration does not fetch or capture files');
  assert.doesNotMatch(compiled, /(?:from\s*['"]react|react\/jsx-runtime|createRoot|innerHTML|sessionStore|sessionStorage|cf-pending)/);
  h.signal.abort();
  assert.deepEqual(h.disposedServices, ['file-inputs', 'file-probes', 'uploads', 'view-resources', 'file-drafts']);
  assert.equal(h.hostListeners.size, 0);
  frontend.dispose?.();
  assert.equal(h.disposedServices.length, 5, 'host cleanup invokes each scoped disposer once');
});

test('activation explicitly rejects missing or unsupported public UI and portal capability', async () => {
  for (const uiSurfaceVersion of [undefined, 0, 2]) {
    const h = harness();
    await assert.rejects(async () => activate({ ...h.context, uiSurfaceVersion } as unknown as ModuleFrontendContext), /uiSurfaceVersion v1/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.services.length, 0);
  }
  for (const version of [undefined, 0, 2]) {
    const h = harness();
    const invalid = { ...h.context, uiVersion: version } as unknown as ModuleFrontendContext;
    await assert.rejects(async () => activate(invalid), /Module UI v1/);
    assert.equal(h.calls.length, 0);
  }
  const h = harness();
  const { createPortal: _portal, ...legacy } = h.context;
  await assert.rejects(async () => activate(legacy as unknown as ModuleFrontendContext), /createPortal/);
  for (const apiVersion of [undefined, 1, 3]) {
    await assert.rejects(async () => activate({ ...h.context, apiVersion } as unknown as ModuleFrontendContext), /frontend API v2/);
  }
  await assert.rejects(async () => activate({
    ...h.context, state: { ...h.context.state, registerDraft: undefined },
  } as unknown as ModuleFrontendContext), /state\.registerDraft/);
});

test('composer middleware only appends the entire list and preserves existing editor behavior', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const draft = new Draft();
  const React = h.context.react;
  const middleware = frontend.components!.find(item => item.boundary === 'composer')!;
  const Base = (_props: ComposerProps) => null;
  const Enhanced = middleware.wrap(Base) as (props: ComposerProps) => unknown;
  const notice = React.createElement('p', { id: 'core-notice' }, 'core context');
  const props: ComposerProps = {
    ...composerProps(frontend, { draft: draft.reference, operation: 'prompt', disabled: false }),
    busy: true, sendBlocked: true, placeholder: 'native placeholder', submitLabel: 'native send',
    children: notice,
  };
  const enhanced = Enhanced(props) as Element;
  assert.equal(enhanced.type, Base, 'the HOC introduces no span/div/placeholder');
  for (const key of ['draft', 'onTextChange', 'onSubmit', 'busy', 'sendBlocked', 'placeholder', 'submitLabel']) {
    assert.equal(enhanced.props[key], props[key as keyof ComposerProps], key);
  }
  const content = enhanced.props.children as Element;
  assert.equal(content.type, React.Fragment, 'composition uses a DOM-free fragment');
  assert.equal((content.props.children as unknown[])[0], notice);
  assert.equal('attachments' in enhanced.props, false);
  assert.deepEqual(Object.keys(enhanced.props).sort(), Object.keys(props).sort(), 'only existing composer content is extended');
  assert.doesNotMatch(source, /onFiles|pickFiles|ComposerInteractions|onKeyDown=|onComposition|stopPropagation/,
    'there is no host file channel or replacement for native keyboard/IME handling');
  frontend.dispose?.();
});

test('editor middleware extends the actual input row without wrapping its button, textarea or submit control', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const draft = new Draft();
  const React = h.context.react;
  const middleware = frontend.components!.find(item => item.boundary === 'composerEditor')!;
  const Base = (_props: ComposerEditorProps) => null;
  const Enhanced = middleware.wrap(Base) as (props: ComposerEditorProps) => unknown;
  const action = React.createElement('button', { id: 'inherited-action' }, 'inherited');
  const props: ComposerEditorProps = {
    ...composerProps(frontend, { draft, operation: 'prompt', disabled: false }),
    children: action, editorRef: { current: null }, placeholder: 'native placeholder', submitLabel: 'native submit',
    onKeyDown() {}, onCompositionStart() {}, onCompositionEnd() {}, title: 'original row',
  };
  const enhanced = Enhanced(props) as Element;
  assert.equal(enhanced.type, Base);
  for (const key of ['draft', 'onTextChange', 'onSubmit', 'onKeyDown', 'onCompositionStart', 'onCompositionEnd',
    'editorRef', 'placeholder', 'submitLabel', 'title']) {
    assert.equal(enhanced.props[key], props[key as keyof ComposerEditorProps], key);
  }
  const tree = h.render(enhanceEditor(frontend), props);
  assert.equal(tree.type, 'div');
  assert.equal(tree.props.className, 'chat-input');
  assert.equal(tree.props.title, props.title);
  assert.equal(tree.props.onKeyDown, props.onKeyDown);
  const children = descendants(tree).filter(element => element.type !== 'svg' && element.type !== 'path');
  const actionIndex = children.findIndex(element => element.props.id === 'inherited-action');
  const uploadIndex = children.findIndex(element => element.props['aria-label'] === '添加文件');
  const textareaIndex = children.findIndex(element => element.type === 'textarea');
  assert.ok(actionIndex < uploadIndex && uploadIndex < textareaIndex);
  assert.equal(children.filter(element => element.type === 'div').length, 1, 'no second editor wrapper');
  assert.equal(children.some(element => element.type === 'span' || element.type === 'input'), false);
  const textarea = children[textareaIndex]!;
  assert.equal(textarea.props.ref, props.editorRef);
  assert.equal(textarea.props.placeholder, props.placeholder);
  const submit = children.find(element => element.props['aria-label'] === 'native send')!;
  assert.equal(submit.props.onClick, props.onSubmit);
  h.unmount(); frontend.dispose?.();
});

test('the entire ready and pending list uses one original section/list immediately before the editor', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const draft = new Draft();
  draft.appendAttachments([{ id: 'native-ready', value: { type: 'directory', path: '/fixture/ready', displayName: 'Ready' } }]);
  selectFiles(frontend, { draft, operation: 'prompt', disabled: false }, [new File(['pending'], 'Pending')]);
  const React = h.context.react;
  const middleware = frontend.components!.find(item => item.boundary === 'composer')!;
  const Editor = enhanceEditor(frontend);
  const Composer = middleware.wrap(props => React.createElement('fixture-composer', {}, props.children,
    React.createElement(Editor, { ...props, children: undefined })));
  const props = { ...composerProps(frontend, { draft, operation: 'prompt', disabled: false }),
    children: React.createElement('p', { id: 'existing-context' }, 'Existing context') };
  const tree = h.render(Composer, props);
  const all = descendants(tree);
  const sections = all.filter(element => element.props.className === 'cf-attachments');
  const lists = all.filter(element => element.props.className === 'cf-attachment-list');
  assert.equal(sections.length, 1);
  assert.equal(lists.length, 1);
  assert.equal(sections[0]!.props['aria-label'], '文件附件');
  const rows = descendants(lists[0]).filter(element => element.type === 'li');
  assert.deepEqual(rows.map(row => row.props.className), ['cf-attachment', 'cf-attachment']);
  assert.deepEqual(rows.map(row => descendants(row).find(element => element.props.className === 'ck-button cf-row-open')!.props.title),
    ['Ready', 'Pending']);
  assert.ok(all.findIndex(element => element.props.id === 'existing-context') < all.indexOf(sections[0]!));
  assert.ok(all.indexOf(sections[0]!) < all.findIndex(element => element.type === 'textarea'));
  assert.equal(all.filter(element => element.props.className === 'cf-row').length, 2);
  assert.doesNotMatch(JSON.stringify(tree), /draft-attachments|module-composer|placeholder-container/);
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.cf-attachments\s*\{[^}]*margin-block:\s*0\.4rem;/s);
  assert.match(css, /\.cf-attachment-list\s*\{[^}]*gap:\s*0\.125rem;[^}]*margin:\s*0;[^}]*padding:\s*0;/s);
  assert.match(css, /\.cf-row\s*\{[^}]*width:\s*32rem;[^}]*max-width:\s*100%;[^}]*height:\s*var\(--ck-control-size\);/s);
  assert.equal('attachments' in draft.reference.getSnapshot(), false);
  h.unmount(); frontend.dispose?.();
});

test('fresh decision drafts hide prompt files while captured uploads settle only their inactive prompt schema', async () => {
  const h = harness();
  let finish!: (response: Response) => void;
  h.context.request = (path, init) => {
    h.calls.push({ path, init });
    return init?.method === 'POST' ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve(new Response(null, { headers: { 'content-type': 'text/plain' } }));
  };
  const frontend = await activate(h.context);
  const prompt = new Draft('shared-session');
  const promptProps = composerProps(frontend, { draft: prompt.reference, operation: 'prompt', disabled: false });
  const promptTree = h.render(enhanceComposer(frontend), promptProps);
  click(descendants(promptTree).find(element => element.props['aria-label'] === '添加文件')!);
  const picker = nativeInputs.at(-1)!;
  prompt.editText('Cached prompt text');
  const ask = new Draft(prompt.sessionId, { kind: 'ask', requestId: 'question-1' });
  ask.editText('Separate answer');
  const askProps = composerProps(frontend, { draft: ask.reference, operation: 'ask', disabled: false });
  const before = h.render(enhanceComposer(frontend), askProps);
  assert.equal(descendants(before).some(element => element.props.className === 'cf-attachments'), false);
  const askUpload = descendants(before).find(element => element.props['aria-label'] === '添加文件')!;
  assert.equal(askUpload.props.className, 'ck-icon-button');
  assert.equal(askUpload.props.disabled, true);
  assert.equal(askUpload.props.title, '当前操作不接受附件');
  assert.equal(editorHandlers(frontend, askProps).onPaste, undefined);
  assert.equal(fileScopes.has(ask.reference), false);
  picker.files = [new File(['file'], 'prompt.txt')];
  picker.dispatchEvent(new Event('change'));
  assert.equal(prompt.blocks, 1);
  assert.equal(ask.blocks, 0);
  finish(Response.json({ fileId, attachment: { type: 'file', path: `/data/files/${fileId}/ready/body.txt`, displayName: 'Prompt upload' } }));
  await settle();
  assert.equal(prompt.fileSnapshot.attachments.length, 1);
  assert.equal(prompt.blocks, 0);
  assert.equal(prompt.snapshot.text, 'Cached prompt text');
  assert.equal(ask.snapshot.text, 'Separate answer');
  assert.equal('attachments' in ask.getSnapshot(), false);
  const replacementAsk = new Draft(prompt.sessionId, { kind: 'ask', requestId: 'question-1' });
  assert.notEqual(replacementAsk.id, ask.id);
  assert.equal(replacementAsk.snapshot.text, '');
  for (const kind of ['plan', 'elicitation'] as const) {
    const decision = new Draft(prompt.sessionId, { kind, requestId: 'other-request' });
    const tree = h.render(composerComponent(frontend), { draft: decision, operation: kind, disabled: false });
    assert.equal(descendants(tree).some(element => String(element.props.className).startsWith('cf-')), false);
    const upload = descendants(tree).find(element => element.props['aria-label'] === '添加文件')!;
    assert.equal(upload.props.disabled, true);
    assert.equal(upload.props.title, '当前操作不接受附件');
    assert.equal(fileScopes.has(decision.reference), false);
  }
  const restored = h.render(composerComponent(frontend), { draft: prompt, operation: 'prompt', disabled: false });
  assert.equal(descendants(restored).filter(element => element.props.className === 'cf-row').length, 1);
  assert.equal(h.calls.filter(call => call.init?.method === 'POST').length, 1);
  h.unmount(); frontend.dispose?.();
});

test('decision editor shows disabled upload affordance without installing file input handlers', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  for (const operation of ['ask', 'plan', 'elicitation'] as const) {
    const draft = new Draft('synthetic-session', { kind: operation, requestId: `${operation}-request` });
    let inherited = 0;
    const props = composerProps(frontend, { draft, operation, disabled: false });
    const inheritedPaste = (event: ReturnType<typeof fileEvent>) => { inherited++; assert.equal(event.defaultPrevented, false); };
    const handlers = editorHandlers(frontend, { ...props, onPaste: inheritedPaste });
    const event = fileEvent([new File(['answer'], `${operation}.txt`)]);
    handlers.onPaste?.(event);
    assert.equal(inherited, 1);
    assert.equal(event.defaultPrevented, false);
    assert.equal(handlers.onDrop, undefined);
    assert.equal(handlers.onDragOver, undefined);
    assert.equal(h.calls.length, 0);
    assert.equal(draft.blocks, 0);
  }
  h.unmount(); frontend.dispose?.();
});

test('ready row removal updates its schema and discards only this activation’s never-submitted upload', async () => {
  const h = harness();
  h.context.request = async (path, init) => {
    h.calls.push({ path, init });
    if (init?.method === 'POST') return Response.json({
      fileId, attachment: { type: 'file', path: `/data/files/${fileId}/ready/body.txt`, displayName: 'Owned' },
    });
    return new Response(null, { status: init?.method === 'DELETE' ? 204 : 200 });
  };
  const frontend = await activate(h.context);
  const draft = new Draft();
  draft.snapshot = { ...draft.snapshot, unconfirmed: true };
  draft.appendAttachments([{ id: 'restored', value: { type: 'file', path: '/fixture/restored', displayName: 'Restored' } }]);
  selectFiles(frontend, { draft, operation: 'prompt', disabled: false }, [new File(['a'], 'Owned')]);
  await settle();
  const render = () => h.render(composerComponent(frontend), { draft, operation: 'prompt', disabled: false });
  const first = render();
  click(descendants(first).find(element => element.props['aria-label'] === '移除 Restored')!);
  assert.equal(h.calls.some(call => call.init?.method === 'DELETE'), false);
  click(descendants(render()).find(element => element.props['aria-label'] === '移除 Owned')!);
  assert.deepEqual(draft.fileSnapshot.attachments, []);
  assert.equal(h.calls.filter(call => call.init?.method === 'DELETE').length, 1,
    'an unrelated old unconfirmed notice does not mark the new upload as submitted');
  assert.equal('attachments' in draft.getSnapshot(), false);
  h.unmount(); frontend.dispose?.();
});

test('editor paste and drop compose inherited handlers and consume files once while mixed text remains native', async () => {
  for (const source of ['onPaste', 'onDrop'] as const) {
    for (const mixed of [false, true]) {
      const h = harness();
      const frontend = await activate(h.context);
      const draft = new Draft();
      draft.editText('Mixed clipboard text stays in the native editor');
      let inherited = 0;
      const props: ComposerEditorProps = {
        ...composerProps(frontend, { draft: draft.reference, operation: 'prompt', disabled: false }),
        [source]: () => { inherited++; },
      };
      const middleware = frontend.components!.find(item => item.boundary === 'composerEditor')!;
      const Enhanced = middleware.wrap(enhanceEditor(frontend));
      const row = h.render(Enhanced, props);
      const callback = row.props[source] as (event: ReturnType<typeof fileEvent>) => void;
      const files = [new File(['first'], 'first.txt'), new File(['second'], 'second.txt')];
      const event = fileEvent(files, mixed ? { 'text/plain': 'native clipboard text' } : {});
      callback(event);
      assert.equal(event.defaultPrevented, source === 'onDrop' || !mixed);
      assert.equal(inherited, 1);
      assert.equal(draft.blocks, 1);
      assert.equal(h.calls.length, 2);
      assert.equal(h.calls[0]!.init!.body, files[0]);
      assert.equal(h.calls[1]!.init!.body, files[1]);
      assert.equal(draft.snapshot.text, 'Mixed clipboard text stays in the native editor');
      const empty = fileEvent([], { 'text/plain': 'ordinary text' });
      callback(empty);
      assert.equal(empty.defaultPrevented, false);
      assert.equal(inherited, 2, 'ordinary text invokes inherited DOM behavior once');
      draft.snapshot = { ...draft.snapshot, pending: true };
      callback(fileEvent(files));
      assert.equal(inherited, 3);
      assert.equal(h.calls.length, 2);
      h.unmount(); frontend.dispose?.();
    }
  }
});

test('inherited editor cancellation wins, callback failures are reported, and disabled file drops never upload', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const draft = new Draft();
  const props = composerProps(frontend, { draft, operation: 'prompt', disabled: false });
  for (const name of ['onPaste', 'onDrop', 'onDragOver'] as const) {
    let inherited = 0;
    const handler = editorHandlers(frontend, {
      ...props, [name]: (event: ReturnType<typeof fileEvent>) => { inherited++; event.preventDefault(); },
    })[name]!;
    const event = fileEvent([new File(['a'], 'a')]);
    handler(event);
    assert.equal(inherited, 1);
    assert.equal(event.dataTransfer.dropEffect, 'none');
    assert.equal(h.calls.length, 0);
    const failure = new Error(`${name} fixture failure`);
    const broken = editorHandlers(frontend, { ...props, [name]: () => { throw failure; } })[name]!;
    assert.doesNotThrow(() => broken(fileEvent([new File(['a'], 'a')])));
    assert.equal(h.errors.at(-1), failure);
  }
  for (const disabled of [true, false]) {
    draft.snapshot = { ...draft.snapshot, pending: !disabled };
    const handlers = editorHandlers(frontend, { ...props, disabled });
    const drag = fileEvent([new File(['a'], 'a')]);
    handlers.onDragOver!(drag);
    assert.equal(drag.defaultPrevented, true);
    assert.equal(drag.dataTransfer.dropEffect, 'none');
    handlers.onDrop!(fileEvent([new File(['a'], 'a')]));
    handlers.onPaste!(fileEvent([new File(['a'], 'a')]));
  }
  assert.equal(h.calls.length, 0);
  assert.equal(draft.blocks, 0);
  frontend.dispose?.();
});

test('file probes follow readonly host visibility and module resources do not cross activations', async () => {
  const a = harness();
  const b = harness();
  a.setHost({ visible: false });
  const first = await activate(a.context);
  const second = await activate(b.context);
  assert.notEqual(a.services[2]!.service, b.services[2]!.service);
  assert.notEqual(a.services[3]!.service, b.services[3]!.service);
  assert.notEqual(a.services[4]!.service, b.services[4]!.service);
  const node: MarkdownNode = {
    kind: 'link', target: './test.txt', label: 'Test',
    origin: { sessionId: 'fixture', messageId: 'visibility' },
  };
  a.render(first.markdown![0]!.component, { node, fallback: 'core fallback' }); a.flushEffects();
  assert.equal(a.calls.length, 0);
  a.setHost({ visible: true });
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0]!.init!.signal!.aborted, false);
  a.setHost({ visible: false });
  assert.equal(a.calls[0]!.init!.signal!.aborted, true);
  first.dispose?.();
  assert.equal(a.hostListeners.size, 0);
  assert.equal(b.hostListeners.size, 1);
  assert.deepEqual(b.disposedServices, []);
  a.unmount();
  second.dispose?.();
});

test('only selected pinned Lucide SVG data is shipped with complete upstream licensing', async () => {
  const upstream = JSON.parse(await readFile(new URL('../../node_modules/lucide-static/icon-nodes.json', import.meta.url), 'utf8'));
  const metadata = JSON.parse(await readFile(new URL('../../node_modules/lucide-static/package.json', import.meta.url), 'utf8'));
  assert.equal(metadata.version, '1.46.0');
  assert.deepEqual(Object.keys(icons).sort(), ['arrow-up-right', 'circle-alert', 'download', 'file', 'file-code',
    'image', 'loader-circle', 'paperclip', 'play', 'rotate-cw', 'x']);
  for (const [name, nodes] of Object.entries(icons)) assert.deepEqual(nodes, upstream[name], name);
  const license = await readFile(new URL('../../node_modules/lucide-static/LICENSE', import.meta.url), 'utf8');
  assert.match(license, /ISC License/);
  assert.match(license, /The MIT License.*for the icons listed above/);
  assert.match(license, /Cole Bemis/);
  const build = await readFile(new URL('../../scripts/build.mjs', import.meta.url), 'utf8');
  assert.match(build, /node_modules\/lucide-static\/LICENSE.*dist\/licenses\/lucide.txt/);
});

function descendants(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...descendants(element.props.children)];
}

function textContent(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (!value || typeof value !== 'object' || !('props' in value)) return '';
  return textContent((value as Element).props.children);
}

function click(element: Element, modifiers: Record<string, unknown> = {}) {
  let prevented = false;
  (element.props.onClick as (event: unknown) => void)({
    button: 0, defaultPrevented: false, ...modifiers, preventDefault() { prevented = true; },
  });
  return prevented;
}

function openFile(tree: Element) {
  click(descendants(tree).find(element => element.props['aria-haspopup'] === 'dialog')!);
}

test('file names show HEAD sizes once in draft, message and inline surfaces', async t => {
  for (const surface of ['draft', 'message', 'link', 'image'] as const) {
    for (const [length, suffix] of [
      [undefined, ''], ['invalid', ''], ['0', ' (0 B)'], ['2048', ' (2.0 KiB)'], ['1258291', ' (1.2 MiB)'],
    ] as const) {
      await t.test(`${surface}: ${length ?? 'unknown'}`, async () => {
        const h = harness();
        h.context.request = async (path, init) => {
          h.calls.push({ path, init });
          return new Response(null, { headers: {
            'content-type': 'application/pdf', ...(length === undefined ? {} : { 'content-length': length }),
          } });
        };
        const frontend = await activate(h.context);
        const name = 'report.pdf';
        const origin = { sessionId: 'size-fixture', messageId: surface };
        const attachment = { type: 'file' as const, path: `/data/files/${fileId}/ready/body.pdf`, displayName: name };
        const draft = new Draft();
        draft.appendAttachments([{ id: 'restored', value: attachment }]);
        const render = () => surface === 'draft'
          ? h.render(composerComponent(frontend), { draft, operation: 'prompt', disabled: false })
          : surface === 'message'
            ? h.render(nativeComponent(frontend), { node: { kind: 'attachment', origin, label: name, attachment } })
            : h.render(frontend.markdown![0]!.component, {
              node: { kind: surface, origin, target: './report.pdf', label: name }, fallback: 'fallback',
            });
        let tree = render();
        assert.doesNotMatch(textContent(tree), /\(\d.*\)/, 'pending HEAD never fabricates a size');
        h.flushEffects(); await settle();
        tree = render();
        const trigger = descendants(tree).find(element => element.props['aria-haspopup'] === 'dialog')!;
        assert.ok(textContent(trigger).includes(name + suffix));
        if (suffix) {
          assert.equal(textContent(tree).split(suffix.slice(2, -1)).length - 1, 1, 'no duplicate size in the row metadata');
          assert.ok(String(trigger.props['aria-description']).includes(suffix.trim()));
        } else {
          assert.doesNotMatch(textContent(tree), /\(\d.*\)/);
          assert.match(String(trigger.props['aria-description']), /application\/pdf/);
        }
        openFile(tree);
        tree = render();
        const title = descendants(tree).find(element => element.type === 'h2')!;
        assert.equal(textContent(title), name + suffix);
        if (suffix) assert.equal(textContent(tree).split(suffix.slice(2, -1)).length - 1, 2, 'one size in each name, none in details');
        for (const download of descendants(tree).filter(element => element.props.download !== undefined)) {
          assert.equal(download.props.download, name, 'display-only size never changes the download filename');
        }
        assert.equal(h.calls.length, 1);
        assert.equal(h.calls[0]!.init?.method, 'HEAD', 'size labels do not download the file body');
        h.unmount(); frontend.dispose?.();
      });
    }
  }
});

test('blob names use decoded sizes and never invent bytes for unavailable data', async () => {
  for (const surface of ['draft', 'message']) {
    for (const [data, suffix] of [['', ' (0 B)'], ['aGVsbG8=', ' (5 B)'], [undefined, ''], ['!', '']] as const) {
      if (surface === 'draft' && data === undefined) continue;
      const h = harness();
      const frontend = await activate(h.context);
      const name = 'local.txt';
      const attachment = { type: 'blob' as const, mimeType: 'text/plain', data, displayName: name };
      const draft = new Draft();
      if (surface === 'draft' && data !== undefined) draft.appendAttachments([{ id: 'blob', value: { ...attachment, data } }]);
      const render = () => surface === 'draft'
        ? h.render(composerComponent(frontend), { draft, operation: 'prompt', disabled: false })
        : h.render(nativeComponent(frontend), { node: {
          kind: 'attachment', origin: { sessionId: 'size-fixture', messageId: 'blob' }, label: name, attachment,
        } });
      render(); h.flushEffects();
      const tree = render();
      const trigger = descendants(tree).find(element => element.props['aria-haspopup'] === 'dialog')!;
      assert.ok(textContent(trigger).includes(name + suffix));
      if (suffix) assert.equal(textContent(tree).split(suffix).length - 1, 1);
      else assert.doesNotMatch(textContent(tree), /\(\d.*\)/);
      assert.equal(h.calls.length, 0);
      h.unmount(); frontend.dispose?.();
    }
  }
});

test('uploads keep size beside the name while pending or failed', async () => {
  for (const type of ['application/pdf', 'image/png']) {
    for (const size of [0, 2048]) {
      const h = harness();
      let respond!: (response: Response) => void;
      h.context.request = () => new Promise(resolve => { respond = resolve; });
      const frontend = await activate(h.context);
      const draft = new Draft();
      const composer = { draft, operation: 'prompt' as const, disabled: false };
      const name = `long-${'name'.repeat(80)}.${type === 'image/png' ? 'png' : 'pdf'}`;
      const suffix = size === 0 ? ' (0 B)' : ' (2.0 KiB)';
      selectFiles(frontend, composer, [new File([new Uint8Array(size)], name, { type })]);
      const render = () => h.render(composerComponent(frontend), composer);
      let tree = render();
      assert.ok(textContent(tree).includes(name + suffix), 'File.size is available before preview effects');
      h.flushEffects();
      tree = render();
      assert.equal(textContent(tree).split(suffix).length - 1, 1);
      assert.ok(descendants(tree).some(element => element.type === 'progress'));
      respond(Response.json({ error: 'Synthetic upload failure' }, { status: 503 }));
      await settle();
      tree = render();
      assert.ok(textContent(tree).includes(name + suffix));
      assert.ok(descendants(tree).some(element => element.props['aria-label'] === `重新上传 ${name}`));
      assert.match(JSON.stringify(tree), /Synthetic upload failure/);
      h.unmount(); frontend.dispose?.();
    }
  }
});

test('native blob cards decode locally, reuse their URL on rerender and revoke it on change or teardown', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const origin = { sessionId: 'fixture', messageId: 'blob' };
  let node: NativeFixture = { kind: 'attachment', origin, label: 'Native text',
    attachment: { type: 'blob', mimeType: 'text/plain', data: 'aGVsbG8=' } };
  const renderNode = nativeComponent(frontend);
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
    const node: NativeFixture = { kind: 'attachment', origin: { sessionId: 'fixture', messageId: 'omitted' },
      label: 'Unavailable image', attachment };
    const renderNode = nativeComponent(frontend);
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

test('media loads only on opening, with a fresh bounded attempt and isolated late callbacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
  const h = harness();
  const frontend = await activate(h.context);
  const renderNode = nativeComponent(frontend);
  const node: NativeFixture = {
    kind: 'attachment', origin: { sessionId: 'fixture', messageId: 'image' }, label: 'Native image',
    attachment: { type: 'blob', mimeType: 'image/png',
      data: syntheticPng },
  };
  const render = () => h.render(renderNode, { node });
  render(); h.flushEffects();
  assert.equal(render().props['aria-busy'], false);
  assert.equal(descendants(render()).some(element => element.type === 'img'), false);
  t.mock.timers.tick(10_000);
  assert.doesNotMatch(JSON.stringify(render()), /预览加载超时/);
  openFile(render());
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
  assert.equal(nextImage.props.src, firstImage.props.src, 'retry reuses available bytes, not another decode/upload');
  assert.notEqual(nextImage.props.key, firstImage.props.key);
  (nextImage.props.onLoad as () => void)();
  assert.equal(render().props['aria-busy'], false);
  h.unmount();
  frontend.dispose?.();
});

test('Markdown matches only local references and keeps original target, label and native provenance', async () => {
  const { context, calls } = harness();
  const frontend = await activate(context);
  const renderer = frontend.markdown![0]!;
  const origin = { sessionId: 'session', messageId: 'message', agentId: 'worker' };
  const base: MarkdownNode = { kind: 'link', label: '<script>safe text</script>', origin, target: './雪%20space.png#part' };
  assert.equal(renderer.matches(base), true);
  assert.equal(renderer.matches({ ...base, kind: 'image' }), true);
  for (const target of ['https://example.test/a.png', 'javascript:alert(1)', 'data:text/html,hello', '#heading', '//other/file']) {
    assert.equal(renderer.matches({ ...base, target }), false);
  }
  const render = renderer.component as unknown as (props: MarkdownRendererProps) => Element;
  const fallback = context.react.createElement('a', { href: 'https://example.test/' }, 'safe fallback');
  const a = render({ node: base, fallback });
  const b = render({ node: { ...base, origin: { ...origin, agentId: 'different-display-alias' } }, fallback });
  assert.equal(a.type, b.type, 'component definitions stay stable across message deltas');
  assert.equal(a.props.url, b.props.url);
  assert.equal(a.props.name, base.label, 'display text is not interpreted as HTML');
  assert.equal(render({ node: { ...base, target: 'https://example.test/' }, fallback }), fallback);
  assert.match(String(a.props.url), /\/cockpit\/_modules\/cockpit-file\/[^/]+\/api\/messages\//);
  assert.equal(base.target, './雪%20space.png#part', 'the original target is not normalized in place');
  assert.equal(calls.length, 0, 'rendering URLs never POSTs capture');
  frontend.dispose?.();
});

test('the module picker opens synchronously and retains its canonical draft across unmount and session switches', async () => {
  const h = harness();
  const frontend = await activate(h.context) as ModuleFrontend;
  const original = new Draft('original');
  const next = new Draft('next');
  const props = composerProps(frontend, { draft: original.reference, disabled: false, operation: 'prompt' });
  const first = h.render(enhanceComposer(frontend), props);
  const previous = nativeInputs.length;
  click(descendants(first).find(element => element.props['aria-label'] === '添加文件')!);
  const picker = nativeInputs.at(-1)!;
  assert.equal(nativeInputs.length, previous + 1);
  assert.equal(picker.clicks, 1, 'the picker opens in the button click stack');
  assert.equal(picker.type, 'file');
  assert.equal(picker.multiple, true);
  assert.equal(descendants(first).some(element => element.type === 'input'), false, 'the input is detached, not a hidden host slot');
  h.unmount();
  h.setHost({ sessionId: next.sessionId });
  h.render(enhanceComposer(frontend), { ...props, draft: next.reference });
  const file = new File(['content'], 'a.txt');
  picker.files = [file];
  picker.dispatchEvent(new Event('change'));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.init!.body, file);
  assert.equal(original.blocks, 1);
  assert.equal(next.blocks, 0);
  assert.equal('appendAttachments' in props.draft, false);
  frontend.dispose?.();
});

test('attachment middleware preserves unknown native values and core actions without a placeholder wrapper', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const middleware = frontend.components!.find(item => item.boundary === 'attachment')!;
  const Base = () => null;
  const Enhanced = middleware.wrap(Base) as (props: AttachmentProps) => unknown;
  const action = h.context.react.createElement('button', { disabled: true, 'aria-label': 'core remove' });
  for (const attachment of [
    { type: 'file' as const, path: '/home/native.txt' },
    { type: 'file' as const, path: `/data/files/${fileId}/identity.json` },
    { type: 'directory' as const, path: '/home/project' },
  ]) {
    const props: AttachmentProps = {
      index: 0, attachment, label: 'Native attachment', children: 'native content', actions: action,
    };
    const tree = Enhanced(props) as Element;
    assert.equal(tree.type, Base);
    assert.equal(tree.props.index, props.index);
    assert.equal(tree.props.children, props.children);
    assert.equal(tree.props.actions, action);
  }
  const tree = h.render(attachmentComponent(frontend), {
    index: 0, attachment: { type: 'blob', mimeType: 'text/plain', data: 'YQ==' },
    label: 'Supported', children: 'core fallback', actions: action,
  });
  assert.equal(tree.type, 'span');
  assert.equal(tree.props.className, 'cf-row', 'replacement is the existing file row itself');
  const coreAction = descendants(tree).find(element => element.props['aria-label'] === 'core remove')!;
  assert.equal(coreAction.props.disabled, true);
  assert.equal(h.calls.length, 0);
  h.unmount();
  frontend.dispose?.();
});

test('attachment action is an accessible borderless icon, not a boxed label', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const draft = new Draft();
  const tree = h.render(composerComponent(frontend), { draft, operation: 'prompt', disabled: false });
  const button = descendants(tree).find(element => element.type === 'button')!;
  assert.equal(button.props.className, 'ck-icon-button');
  assert.equal(button.props['aria-label'], '添加文件');
  assert.match(String(button.props.title), /添加文件/);
  const icon = descendants(button).find(element => element.type === 'svg')!;
  assert.equal(icon.props.width, '24');
  assert.equal(icon.props.height, '24');
  assert.equal(icon.props.strokeWidth, '2');
  assert.equal(icon.props.strokeLinecap, 'round');
  assert.equal(icon.props.strokeLinejoin, 'round');
  assert.equal(descendants(button).some(element => element.type === 'span'), false);
  const ask = new Draft(draft.sessionId, { kind: 'ask', requestId: 'question' });
  const answer = h.render(composerComponent(frontend), { draft: ask, operation: 'ask', disabled: false });
  const unavailable = descendants(answer).find(element => element.props['aria-label'] === '添加文件')!;
  assert.equal(unavailable.props.className, 'ck-icon-button');
  assert.equal(unavailable.props.disabled, true);
  assert.equal(unavailable.props.title, '当前操作不接受附件');
  assert.equal(descendants(answer).some(element => element.props['aria-label'] === 'native send'), true);
  frontend.dispose?.();
});

test('each selection has its own row and preview resource, honest progress and independent remove/retry', async () => {
  const h = harness();
  const responses: ((response: Response) => void)[] = [];
  h.context.request = (path, init) => {
    h.calls.push({ path, init });
    return new Promise(resolve => responses.push(resolve));
  };
  const frontend = await activate(h.context);
  const draft = new Draft();
  const composer: ComposerTarget = { draft, operation: 'prompt', disabled: false };
  const file = new File([Buffer.from(syntheticPng, 'base64')], '同名-很长的图片-'.repeat(12) + '.png', { type: 'image/png' });
  assert.equal(selectFiles(frontend, composer, [file, file]), true);
  const render = () => h.render(composerComponent(frontend), composer);
  render(); h.flushEffects();
  let tree = render();
  assert.equal(descendants(tree).filter(element => element.type === 'img').length, 0);
  const originalUrls: string[] = [];
  for (const row of descendants(tree).filter(element => element.props.className === 'cf-row')) {
    openFile(row);
    tree = render(); h.flushEffects();
    const image = descendants(tree).find(element => element.type === 'img')!;
    originalUrls.push(String(image.props.src));
    (image.props.onLoad as () => void)();
    (descendants(tree).find(element => element.type === 'dialog')!.props.onClose as () => void)();
    tree = render(); h.flushEffects();
  }
  assert.notEqual(originalUrls[0], originalUrls[1]);
  assert.equal((await (await fetch(originalUrls[0]!)).blob()).size, file.size);
  const cards = descendants(tree).filter(element => element.props.className === 'cf-row');
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
  assert.equal(draft.fileSnapshot.attachments.length, 0, 'late success of a removed item is ignored');
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
  assert.equal(draft.fileSnapshot.attachments.length, 1);
  await assert.rejects(fetch(originalUrls[1]!));
  assert.equal(h.calls[4]!.init!.method, 'HEAD');
  responses[4]!(new Response(null, { headers: { 'content-type': 'image/png', 'content-length': `${file.size}` } }));
  await settle();
  tree = render();
  assert.equal(descendants(tree).some(element => element.type === 'img'), false);
  openFile(tree);
  tree = render(); h.flushEffects();
  const images = descendants(tree).filter(element => element.type === 'img');
  assert.equal(images.length, 1);
  assert.equal(images[0]!.props.src, `${apiBase}/files/${fileId}/body.png`);
  (images[0]!.props.onLoad as () => void)();
  (descendants(tree).find(element => element.type === 'dialog')!.props.onClose as () => void)();
  tree = render();
  assert.equal(descendants(tree).filter(element => element.props.className === 'cf-row').length, 1);
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
  const composer: ComposerTarget = { draft, disabled: false, operation: 'prompt' };
  selectFiles(frontend, composer, [new File(['pending'], 'Uploading')]);
  selectFiles(frontend, composer, [new File([new Uint8Array(100_001)], 'Failed')]);
  const render = () => {
    return descendants(h.render(composerComponent(frontend), composer));
  };
  const unlocked = render();
  assert.ok(unlocked.some(element => element.props['aria-label'] === '重新上传 Failed'));
  draft.snapshot = { ...draft.snapshot, pending: true };
  const locked = render();
  for (const label of ['添加文件', '移除 Ready', '移除 Uploading', '移除 Failed', '重新上传 Failed']) {
    assert.equal(locked.find(element => element.props['aria-label'] === label)!.props.disabled, true, label);
  }
  draft.snapshot = { ...draft.snapshot, pending: false };
  for (const element of render().filter(element => element.type === 'button' && /添加文件|移除|重新上传/.test(String(element.props['aria-label'])))) {
    assert.equal(!!element.props.disabled, false);
  }
  assert.equal(unlocked.some(element => element.type === 'input'), false, 'the module-owned picker is detached from the editor');
  h.unmount();
  frontend.dispose?.();
});

test('a file picker opened before sending cannot upload its late selection during pending', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const draft = new Draft();
  const composer = composerProps(frontend, { draft, operation: 'prompt', disabled: false });
  const tree = h.render(enhanceComposer(frontend), composer);
  click(descendants(tree).find(element => element.props['aria-label'] === '添加文件')!);
  const picker = nativeInputs.at(-1)!;
  draft.snapshot = { ...draft.snapshot, pending: true };
  picker.files = [new File(['late'], 'late.txt')];
  picker.dispatchEvent(new Event('change'));
  assert.equal(h.calls.length, 0);
  assert.equal(draft.blocks, 0);
  h.unmount();
  frontend.dispose?.();
});
test('selection preview URLs release on view unmount and module stop without cancelling a switched-away draft', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const draft = new Draft();
  const composer: ComposerTarget = { draft, operation: 'prompt', disabled: false };
  selectFiles(frontend, composer, [new File([Buffer.from(syntheticPng, 'base64')], 'pixel.png', { type: 'image/png' })]);
  const render = () => h.render(composerComponent(frontend), composer);
  render(); h.flushEffects();
  openFile(render()); render(); h.flushEffects();
  const first = String(descendants(render()).find(element => element.type === 'img')!.props.src);
  h.unmount();
  await assert.rejects(fetch(first));
  assert.equal(draft.blocks, 1);
  assert.equal(h.calls[0]!.init!.signal!.aborted, false);
  render(); h.flushEffects();
  openFile(render()); render(); h.flushEffects();
  const second = String(descendants(render()).find(element => element.type === 'img')!.props.src);
  assert.notEqual(second, first);
  h.signal.abort();
  await assert.rejects(fetch(second));
  assert.equal(h.calls[0]!.init!.signal!.aborted, true);
  assert.equal(draft.blocks, 0, 'module loss releases its generic leases without host file fallback');
  assert.deepEqual(draft.getSnapshot().blocks, []);
  assert.equal(h.calls.length, 1, 'teardown does not delete originals');
  h.unmount();
});

test('draft and native attachments share rows and canonical URLs without background media downloads', async () => {
  const h = harness();
  h.context.request = async (path, init) => {
    h.calls.push({ path, init });
    return new Response(null, { headers: { 'content-type': 'image/png', 'content-length': '68' } });
  };
  const frontend = await activate(h.context);
  const draft = new Draft();
  const attachment = { type: 'file' as const, path: `/data/files/${fileId}/ready/body.png`, displayName: 'Restored pixel' };
  draft.appendAttachments([{ id: 'restored', value: attachment }]);
  const composer: ComposerTarget = { draft, operation: 'prompt', disabled: false };
  const component = composerComponent(frontend);
  h.render(component, composer); h.flushEffects(); await settle();
  let draftTree = h.render(component, composer);
  const card = descendants(draftTree).find(element => element.props.className === 'cf-row')!;
  assert.equal(descendants(card).some(element => element.type === 'img'), false);
  openFile(card);
  draftTree = h.render(component, composer); h.flushEffects();
  const image = descendants(draftTree).find(element => element.type === 'img')!;
  assert.equal(image.props.src, `${apiBase}/files/${fileId}/body.png`);
  (image.props.onLoad as () => void)();
  const node: NativeFixture = { kind: 'attachment', origin: { sessionId: 'fixture', messageId: 'restored' }, label: attachment.displayName, attachment };
  const chat = h.render(nativeComponent(frontend), { node });
  h.flushEffects();
  assert.equal(chat.props.className, card.props.className);
  assert.equal(descendants(chat).some(element => element.type === 'img'), false);
  assert.equal(descendants(chat).find(element => element.type === 'a')!.props.href, `${image.props.src}?download=1`);
  assert.ok(h.calls.every(call => call.init!.method === 'HEAD'));
  assert.equal(h.calls.length, 1, 'mounted consumers share the same five-second probe round');
  assert.doesNotMatch(source, /response\.blob\(|fetch\(|createRoot|sessionStorage|sendPrompt|\.submit\(/);
  h.unmount();
  frontend.dispose?.();
});

test('a row opens an explicitly closable native dialog and a changed resource closes it', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  let node: NativeFixture = { kind: 'attachment', origin: { sessionId: 'fixture', messageId: 'preview' }, label: 'Synthetic pixel',
    attachment: { type: 'blob', mimeType: 'image/png', data: syntheticPng } };
  const render = () => h.render(nativeComponent(frontend), { node });
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
  assert.equal(close.props.autoFocus, undefined, 'showModal selects the first close control without React autofocus');
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
  assert.equal(tree.props['aria-busy'], false, 'the new resource is not loading a preview until opened');
  assert.equal(descendants(tree).some(element => element.type === 'dialog'), false);
  assert.ok(closed >= 2);
  h.unmount();
  frontend.dispose?.();
});

test('Markdown SVG references fetch metadata only until opened and preview without executing markup', async () => {
  const h = harness();
  h.context.request = async (path, init) => {
    h.calls.push({ path, init });
    return new Response(null, { headers: { 'content-type': 'image/svg+xml', 'content-length': '200' } });
  };
  const frontend = await activate(h.context);
  const node: MarkdownNode = {
    kind: 'image', origin: { sessionId: 'fixture', messageId: 'svg' },
    target: 'files/diagram.svg', label: 'Diagram',
  };
  const render = () => h.render(frontend.markdown![0]!.component, { node, fallback: 'safe fallback' });
  render(); h.flushEffects(); await settle();
  let tree = render();
  assert.equal(tree.props.className, 'cf-reference');
  assert.equal(descendants(tree).some(element => element.type === 'img'), false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.init?.method, 'HEAD');
  openFile(tree);
  tree = render();
  const expanded = descendants(tree).filter(element => element.type === 'img');
  assert.equal(expanded.length, 1);
  assert.match(String(expanded[0]!.props.src), /\/messages\//);
  assert.equal(descendants(tree).some(element => ['iframe', 'object', 'embed'].includes(String(element.type))), false);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML\s*=/);
  h.unmount();
  frontend.dispose?.();
});

test('module stop closes its body-mounted modal and a stale trigger cannot reopen it', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  const node: NativeFixture = { kind: 'attachment', origin: { sessionId: 'fixture', messageId: 'stop-dialog' },
    label: 'Synthetic details', attachment: { type: 'blob', mimeType: 'text/plain', data: 'aGVsbG8=' } };
  const render = () => h.render(nativeComponent(frontend), { node });
  render(); h.flushEffects();
  const trigger = descendants(render()).find(element => element.props['aria-haspopup'] === 'dialog')!;
  (trigger.props.onClick as () => void)();
  const dialog = descendants(render()).find(element => element.type === 'dialog')!;
  let closed = 0;
  (dialog.props.ref as { current: unknown }).current = {
    showModal() {},
    close() { closed++; (dialog.props.onClose as () => void)(); },
  };
  h.flushEffects();
  h.signal.abort();
  assert.equal(closed, 1);
  (trigger.props.onClick as () => void)();
  assert.equal(descendants(render()).some(element => element.type === 'dialog'), false);
  h.unmount();
  frontend.dispose?.();
});
test('audio/video controls stay behind an explicit play action and unsafe document types stay download-only', async () => {
  for (const mimeType of ['audio/wav', 'video/mp4', 'application/pdf', 'text/html']) {
    const h = harness();
    const frontend = await activate(h.context);
    const node: NativeFixture = { kind: 'attachment', origin: { sessionId: 'fixture', messageId: mimeType }, label: 'Synthetic media',
      attachment: { type: 'blob', mimeType, data: 'c3ludGhldGlj' } };
    const render = () => h.render(nativeComponent(frontend), { node });
    render(); h.flushEffects();
    let tree = render();
    assert.equal(descendants(tree).some(element => ['iframe', 'object', 'embed', 'dialog'].includes(String(element.type))), false);
    assert.equal(descendants(tree).some(element => element.props.controls), false);
    const play = descendants(tree).find(element => element.props['aria-label'] === '播放 Synthetic media');
    if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
      assert.ok(play);
      (play.props.onClick as () => void)();
      tree = render(); h.flushEffects();
      const players = descendants(tree).filter(element => element.props.controls === true);
      assert.equal(players.length, 1);
      (players[0]!.props.onLoadedMetadata as () => void)();
      assert.equal(render().props['aria-busy'], false);
      (players[0]!.props.onError as () => void)();
      tree = render();
      assert.match(JSON.stringify(tree), /未能显示/);
      assert.equal(descendants(tree).some(element => element.type === 'dialog'), true, 'failure details stay open with retry and download');
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

test('compact row and inline styles stay scoped and preserve independent layout contracts', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const source = await readFile(new URL('./index.tsx', import.meta.url), 'utf8');
  assert.match(source, /className="ck-surface ck-modal cf-preview-dialog"/);
  assert.match(source, /<h2 className="ck-heading cf-dialog-name"/);
  assert.match(source, /className="ck-actions cf-dialog-actions"/);
  const modal = css.match(/\.cf-preview-dialog\s*\{([^}]+)\}/)![1]!;
  assert.doesNotMatch(modal, /background:|border:|border-radius:|padding:|font:/);
  assert.doesNotMatch(css, /::backdrop|\.cf-row .cf-row-open:focus-visible/);
  assert.doesNotMatch(css, /\.cf-(?:upload-button|icon-button|button)\b/, 'generic button appearance belongs to the host');
  assert.doesNotMatch(css, /var\(--(?!ck-|cf-)/, 'only public host tokens or module-owned business tokens');
  assert.doesNotMatch(css, /:hover|cursor:/, 'generic hover and interaction appearance use public CSS');
  assert.match(css, /\.cf-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) var\(--cf-actions-width\);[^}]*max-width:\s*100%;[^}]*height:\s*var\(--ck-control-size\);/s);
  assert.match(css, /\.cf-name-stem\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s);
  assert.match(css, /\.cf-name-extension\s*\{[^}]*max-width:\s*45%;/s);
  assert.match(css, /\.cf-name-text\s*\{[^}]*display:\s*flex;[^}]*min-width:\s*0;/s);
  assert.match(css, /\.cf-name-size\s*\{[^}]*flex:\s*none;[^}]*white-space:\s*pre;/s);
  assert.match(css, /\.cf-row-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2, var\(--ck-control-size\)\);/s);
  assert.match(css, /\.cf-expanded-media\s*\{[^}]*object-fit:\s*contain;/s);
  assert.match(css, /\.cf-attachment-list\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(css, /\.cf-reference-name\s*\{[^}]*display:\s*inline;[^}]*font:\s*inherit;[^}]*line-height:\s*inherit;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(css, /\.cf-reference-link\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
  assert.doesNotMatch(css, /\b(?:body|html|:root)\b|\.chat-|line-clamp|\.cf-thumbnail|\.cf-card/);
  const selectors = [...css.matchAll(/(?:^|})\s*([^{}]+)\{/g)].flatMap(match => match[1]!.split(','));
  assert.ok(selectors.every(selector => selector.trim().startsWith('.cf-') ||
    selector.trim() === '@container cf-row (max-width: 26rem)'), 'no global host CSS overrides');
});

test('full names and errors are accessible on touch while all tile information and actions use fixed slots', async () => {
  for (const name of ['项目说明'.repeat(80) + '.png', 'a'.repeat(300) + '.tar.gz', 'x.' + 'b'.repeat(300), '.gitignore', '🖼️ صورة طويلة.png', 'no-extension']) {
    const h = harness();
    const frontend = await activate(h.context);
    const draft = new Draft();
    const composer: ComposerTarget = { draft, disabled: false, operation: 'prompt' };
    selectFiles(frontend, composer, [new File([new Uint8Array(100_001)], name)]);
    const render = () => h.render(composerComponent(frontend), composer);
    let tree = render();
    const card = descendants(tree).find(element => element.props.className === 'cf-row')!;
    const info = descendants(card).find(element => element.props.className === 'cf-row-name')!;
    const actions = descendants(card).find(element => element.props.className === 'cf-row-actions')!;
    assert.equal(descendants(actions).filter(element => element.type === 'button').length, 2);
    assert.equal(descendants(info).some(element => element.type === 'button'), false);
    const openButton = descendants(card).find(element => element.props.className === 'ck-button cf-row-open')!;
    assert.equal(openButton.type, 'button');
    assert.equal(openButton.props.title, name);
    const stem = descendants(info).find(element => element.props.className === 'cf-name-stem')!;
    const extension = descendants(info).find(element => element.props.className === 'cf-name-extension');
    assert.equal((stem.props.children as string[]).join('') + (extension?.props.children as string[] ?? []).join(''), name);
    assert.equal(extension !== undefined, name.endsWith('.png') || name.endsWith('.tar.gz'));
    (openButton.props.onClick as () => void)();
    tree = render();
    const dialog = descendants(tree).find(element => element.type === 'dialog')!;
    assert.equal(dialog.props['aria-label'], `文件详情 ${name}`);
    assert.equal(textContent(descendants(dialog).find(element => element.props.className === 'ck-heading cf-dialog-name')), `${name} (97.7 KiB)`);
    assert.match(JSON.stringify(dialog), /upload limit/);
    assert.equal(descendants(dialog).some(element => ['img', 'video', 'iframe', 'object'].includes(String(element.type))), false);
    (dialog.props.onClose as () => void)();
    tree = render();
    const errorButton = descendants(tree).find(element => element.props.className === 'ck-button cf-row-open')!;
    assert.match(String(errorButton.props['aria-description']), /upload limit/);
    (errorButton.props.onClick as () => void)();
    assert.ok(descendants(render()).some(element => element.type === 'dialog'));
    h.unmount();
    frontend.dispose?.();
  }
});

test('one row button owns visible content, actions are siblings and late dialog close stays scoped', async () => {
  const h = harness();
  const frontend = await activate(h.context);
  let node: NativeFixture = {
    kind: 'attachment', origin: { sessionId: 'fixture', messageId: 'card-preview' }, label: 'Long image name.png',
    attachment: { type: 'blob', mimeType: 'image/png', data: syntheticPng },
  };
  const render = () => h.render(nativeComponent(frontend), { node });
  render(); h.flushEffects();
  let tree = render();
  const trigger = descendants(tree).find(element => element.props.className === 'ck-button cf-row-open')!;
  assert.equal(trigger.props['aria-label'], '查看 Long image name.png');
  assert.equal(descendants(tree).filter(element => element.props['aria-haspopup'] === 'dialog').length, 1);
  assert.equal(descendants(tree).find(element => element.props.className === 'cf-file-icon')!.type, 'span');
  assert.equal(descendants(tree).find(element => element.props.className === 'cf-row-name')!.type, 'span');
  assert.equal(descendants(trigger).some(element => element.type === 'a'), false, 'download is not nested inside preview');
  assert.ok(descendants(trigger).some(element => element.props.className === 'cf-file-icon'));
  assert.ok(descendants(trigger).some(element => element.props.className === 'cf-row-name'));
  assert.equal(tree.props['aria-label'], undefined, 'the main action, not a second group label, names the file');
  assert.equal(tree.props.onClick, undefined, 'actions cannot bubble to a container preview handler');
  (trigger.props.onClick as () => void)();
  tree = render();
  const original = descendants(tree).find(element => element.type === 'dialog')!;
  const portal = descendants(tree).find(element => element.type === 'fixture-portal')!;
  assert.ok(descendants(portal).includes(original), 'the flow-content dialog is mounted through the portal');
  assert.equal(original.props['aria-label'], '预览 Long image name.png');
  assert.equal(descendants(original).filter(element => element.type === 'img').length, 1);
  node = { ...node, attachment: { type: 'blob', mimeType: 'image/svg+xml',
    data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>') } };
  render(); h.flushEffects();
  tree = render();
  assert.equal(descendants(tree).some(element => element.type === 'dialog'), false);
  openFile(tree);
  tree = render();
  const next = descendants(tree).find(element => element.type === 'dialog')!;
  assert.notEqual(next.props.key, original.props.key);
  (original.props.onClose as () => void)();
  assert.equal(descendants(render()).find(element => element.type === 'dialog')!.props.key, next.props.key);
  h.unmount();
  frontend.dispose?.();
});

test('row progress and reserved actions never add height or use an overlay hit target', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.cf-row-open\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*1\.25rem minmax\(0, 1fr\) var\(--cf-status-width\);[^}]*height:\s*100%;/s);
  assert.doesNotMatch(css, /\.cf-row \.cf-row-open:focus-visible/, 'row buttons retain shared inset focus');
  assert.match(css, /\.cf-progress\s*\{[^}]*position:\s*absolute;[^}]*height:\s*2px;/s);
  assert.match(css, /container:\s*cf-row \/ inline-size;/);
  const narrow = css.slice(css.indexOf('@container cf-row'));
  assert.match(narrow, /\.cf-row-open\s*\{[^}]*grid-template-columns:\s*1\.25rem minmax\(0, 1fr\);[^}]*grid-template-rows:\s*1fr 1fr;/s);
  assert.match(narrow, /\.cf-name-stem\s*\{[^}]*min-width:\s*1ch;/s);
  assert.match(narrow, /\.cf-row-status\s*\{[^}]*grid-column:\s*2;/s);
  assert.doesNotMatch(css, /pointer-events|cf-card-open|cf-preview-button/);
});

test('a card opened before image metadata arrives becomes the preview rather than staying an empty details dialog', async () => {
  const h = harness();
  let respond!: (response: Response) => void;
  h.context.request = () => new Promise<Response>(resolve => { respond = resolve; });
  const frontend = await activate(h.context);
  const node: MarkdownNode = { kind: 'image', origin: { sessionId: 'fixture', messageId: 'late-metadata' },
    target: './image.svg', label: 'Loading image' };
  const render = () => h.render(frontend.markdown![0]!.component, { node, fallback: 'safe fallback' });
  let tree = render(); h.flushEffects();
  openFile(tree);
  tree = render();
  const initial = descendants(tree).find(element => element.type === 'dialog')!;
  let opens = 0, closes = 0;
  (initial.props.ref as { current: unknown }).current = { showModal: () => { opens++; }, close: () => { closes++; } };
  h.flushEffects();
  respond(new Response(null, { headers: { 'content-type': 'image/svg+xml', 'content-length': '200' } }));
  await settle();
  tree = render(); h.flushEffects();
  const preview = descendants(tree).find(element => element.type === 'dialog')!;
  assert.equal(preview.props['aria-label'], '预览 Loading image');
  assert.equal(descendants(preview).filter(element => element.type === 'img').length, 1);
  assert.equal(opens, 1);
  assert.equal(closes, 0, 'metadata arrival must not close and refocus the modal');
  h.unmount();
  frontend.dispose?.();
});

test('Markdown links and images stay inline regardless of labels, line breaks or media availability', async () => {
  for (const kind of ['link', 'image'] as const) {
    const h = harness();
    h.context.request = async () => new Response(null, { headers: { 'content-type': 'application/octet-stream', 'content-length': '42' } });
    const frontend = await activate(h.context);
    const name = '报告-'.repeat(100) + 'report.py:128';
    const node: MarkdownNode = { kind, origin: { sessionId: 'fixture', messageId: kind },
      target: 'report.py#L128', label: name };
    const render = () => h.render(frontend.markdown![0]!.component, { node, fallback: 'safe fallback' });
    let tree = render(); h.flushEffects(); await settle();
    tree = render();
    assert.equal(tree.props.className, 'cf-reference');
    const link = descendants(tree).find(element => element.type === 'a')!;
    assert.equal(link.props.className, 'cf-reference-link');
    assert.match(String(link.props.href), /\/messages\//);
    assert.deepEqual(descendants(link).find(element => element.props.className === 'cf-reference-name')!.props.children, [name]);
    assert.equal(descendants(tree).filter(element => element.type === 'a').length, 1);
    assert.equal(descendants(tree).some(element => ['button', 'img', 'progress'].includes(String(element.type))), false);
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      assert.equal(click(link, modifiers), false, 'modified clicks retain native link behavior');
      assert.equal(descendants(render()).some(element => element.type === 'dialog'), false);
    }
    assert.equal(click(link), true);
    const dialog = descendants(render()).find(element => element.type === 'dialog')!;
    assert.ok(descendants(dialog).some(element => element.props['aria-label'] === `下载 ${name}`));
    assert.match(JSON.stringify(dialog), /暂不支持预览/);
    assert.equal(descendants(link).some(element => element.props['aria-label'] === `下载 ${name}`), false);
    h.unmount(); frontend.dispose?.();
  }
});

test('inline errors retain one link and expose the complete cause and retry only in the dialog', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100 });
  const h = harness();
  const frontend = await activate(h.context);
  const node: MarkdownNode = { kind: 'image', origin: { sessionId: 'fixture', messageId: 'inline-timeout' },
    target: './unresolved.png', label: 'Same name' };
  const render = () => h.render(frontend.markdown![0]!.component, { node, fallback: 'safe fallback' });
  render(); h.flushEffects();
  t.mock.timers.tick(5001);
  const failed = render();
  assert.equal(failed.props.className, 'cf-reference');
  assert.equal(descendants(failed).filter(element => element.type === 'a').length, 1);
  assert.equal(descendants(failed).some(element => element.type === 'button'), false);
  const link = descendants(failed).find(element => element.type === 'a')!;
  assert.match(String(link.props['aria-description']), /availability is still unknown/);
  openFile(failed);
  const dialog = descendants(render()).find(element => element.type === 'dialog')!;
  assert.match(JSON.stringify(dialog), /availability is still unknown/);
  assert.ok(descendants(dialog).some(element => element.props['aria-label'] === '重新加载 Same name'));
  h.unmount(); frontend.dispose?.();
});

test('retry hands focus to the persistent close control before replacing its own modal action', async () => {
  const h = harness();
  h.context.request = async () => new Response(null, { status: 503 });
  const frontend = await activate(h.context);
  const node: MarkdownNode = { kind: 'link', origin: { sessionId: 'fixture', messageId: 'retry-focus' },
    target: './report.txt', label: 'Retry target' };
  const render = () => h.render(frontend.markdown![0]!.component, { node, fallback: 'safe fallback' });
  render(); h.flushEffects(); await settle();
  openFile(render());
  const dialog = descendants(render()).find(element => element.type === 'dialog')!;
  const close = descendants(dialog).find(element => element.type === 'button')!;
  let focused = 0;
  (close.props.ref as { current: unknown }).current = { focus(options: unknown) {
    assert.deepEqual(options, { preventScroll: true });
    focused++;
  } };
  const retry = descendants(dialog).find(element => element.props.className === 'cf-dialog-retry')!;
  const capture = retry.props.onClickCapture as (event: unknown) => void;
  capture({ currentTarget: { contains: () => false, ownerDocument: { activeElement: null } } });
  assert.equal(focused, 0, 'retry cannot take focus from an unrelated modal control');
  capture({ currentTarget: { contains: () => true, ownerDocument: { activeElement: {} } } });
  click(descendants(retry).find(element => element.type === 'button')!);
  assert.equal(focused, 1);
  assert.equal(descendants(render()).find(element => element.type === 'dialog')!.props.key, dialog.props.key);
  h.unmount(); frontend.dispose?.();
});

test('activation owns unload guards for hidden unfinished drafts and removes them on disposal', async () => {
  const listeners = new Set<(event: BeforeUnloadEvent) => void>();
  Object.defineProperty(document, 'defaultView', { configurable: true, value: {
    addEventListener(type: string, listener: (event: BeforeUnloadEvent) => void) {
      assert.equal(type, 'beforeunload'); listeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: BeforeUnloadEvent) => void) {
      assert.equal(type, 'beforeunload'); listeners.delete(listener);
    },
  } });
  const h = harness();
  const frontend = await activate(h.context);
  const draft = new Draft('hidden-unload');
  const tree = h.render(enhanceEditor(frontend), composerProps(frontend, {
    draft: draft.reference, operation: 'prompt', disabled: false,
  }));
  const upload = descendants(tree).find(item => item.props['aria-label'] === '添加文件')!;
  click(upload);
  const input = nativeInputs.at(-1)!;
  input.files = [new File(['synthetic'], 'hidden.txt')];
  input.dispatchEvent(new Event('change'));
  h.unmount();
  const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
  Object.defineProperty(event, 'returnValue', { value: 'unchanged', writable: true });
  assert.equal(listeners.size, 1);
  for (const listener of listeners) listener(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.calls[0]!.init!.signal!.aborted, false, 'asking to leave cannot stop an upload');
  h.signal.abort();
  assert.equal(listeners.size, 0);
  assert.equal(h.calls[0]!.init!.signal!.aborted, true);
  frontend.dispose?.();
  Object.defineProperty(document, 'defaultView', { configurable: true, value: undefined });
});
