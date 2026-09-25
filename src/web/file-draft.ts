import type {
  ComposerTarget, DraftReference, DraftSchemaHandle, DraftSchemaRegistration, DraftSchemaScope,
  ModuleDraft, ModuleDraftSnapshot, ModuleStateRegistry, NativeAttachment,
} from '@waksana/cockpit-module-sdk/frontend';

export const MAX_ATTACHMENTS = 20;
type ReadonlyData<T> = { readonly [Key in keyof T]: ReadonlyData<T[Key]> };

export interface FileAttachment {
  readonly id: string;
  readonly value: ReadonlyData<NativeAttachment>;
}

export interface FileState {
  /** Edit tokens distinguish same-value replacements at ACK; they never authorize file deletion. */
  readonly revision: number;
  readonly attachments: readonly (FileAttachment & { readonly revision: number })[];
}

export interface FileDraftSnapshot extends ModuleDraftSnapshot {
  readonly attachments: readonly FileAttachment[];
}

export interface FileDraft extends DraftReference {
  getSnapshot(): FileDraftSnapshot;
  appendAttachments(items: readonly FileAttachment[]): void;
  removeAttachment(id: string): void;
  block(reason: string): () => void;
}

export interface FileComposerContext extends ComposerTarget {
  readonly draft: FileDraft;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid file draft data');
  return value as Record<string, unknown>;
}

function text(value: unknown, nonempty = false): string {
  if (typeof value !== 'string' || (nonempty && !value)) throw new Error('Invalid native attachment string');
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid file draft revision or position');
  return value;
}

// Mirrors the existing native route's strict attachment shapes without a browser SDK runtime import.
export function validateNativeAttachment(input: unknown): ReadonlyData<NativeAttachment> {
  const kind = input && typeof input === 'object' && 'type' in input ? input.type : undefined;
  const keys = kind === 'file' || kind === 'directory' ? ['type', 'path', 'displayName']
    : kind === 'selection' ? ['type', 'filePath', 'displayName', 'selection', 'text']
      : kind === 'blob' ? ['type', 'data', 'mimeType', 'displayName'] : [];
  const value = record(input, keys);
  const displayName = value.displayName === undefined ? {} : { displayName: text(value.displayName) };
  if (kind === 'file' || kind === 'directory') {
    return Object.freeze({ type: kind, path: text(value.path, true), ...displayName });
  }
  if (kind === 'blob') {
    return Object.freeze({ type: kind, data: text(value.data), mimeType: text(value.mimeType, true), ...displayName });
  }
  if (kind === 'selection') {
    const position = (input: unknown) => {
      const value = record(input, ['line', 'character']);
      return Object.freeze({ line: integer(value.line), character: integer(value.character) });
    };
    const range = value.selection === undefined ? undefined : record(value.selection, ['start', 'end']);
    return Object.freeze({
      type: kind, filePath: text(value.filePath, true), displayName: text(value.displayName),
      ...(value.text === undefined ? {} : { text: text(value.text) }),
      ...(range ? { selection: Object.freeze({ start: position(range.start), end: position(range.end) }) } : {}),
    });
  }
  throw new Error('Invalid native attachment type');
}

function attachmentInputs(input: unknown): readonly FileAttachment[] {
  if (!Array.isArray(input) || input.length > MAX_ATTACHMENTS) throw new Error('A prompt supports at most 20 attachments');
  const ids = new Set<string>();
  return input.map(item => {
    const value = record(item, ['id', 'value', 'revision']);
    const id = text(value.id, true);
    if (ids.has(id)) throw new Error('Duplicate attachment ID');
    ids.add(id);
    return Object.freeze({ id, value: validateNativeAttachment(value.value) });
  });
}

export function validateFileState(input: unknown): FileState {
  const value = record(input, ['revision', 'attachments']);
  const revision = integer(value.revision);
  const attachments = attachmentInputs(value.attachments).map((item, index) => {
    const entry = (value.attachments as Record<string, unknown>[])[index]!;
    const version = integer(entry.revision);
    if (!version || version > revision) throw new Error('Invalid attachment revision');
    return Object.freeze({ ...item, revision: version });
  });
  return Object.freeze({ revision, attachments: Object.freeze(attachments) });
}

export const fileDraftSchema: DraftSchemaRegistration<FileState> = {
  id: 'attachments',
  purposes: ['prompt'],
  create: () => validateFileState({ revision: 0, attachments: [] }),
  validate: validateFileState,
  hasContent: state => state.attachments.length > 0,
  project: state => state.attachments.length ? { attachments: state.attachments.map(item => item.value) } : undefined,
  acknowledge: (current, captured) => {
    const submitted = new Map(captured.attachments.map(item => [item.id, item]));
    return {
      revision: current.revision,
      attachments: current.attachments.filter(item => {
        const previous = submitted.get(item.id);
        return !previous || previous.revision !== item.revision || JSON.stringify(previous.value) !== JSON.stringify(item.value);
      }),
    };
  },
  persistence: {
    serialize: state => JSON.stringify({ version: 1, ...validateFileState(state) }),
    restore: ({ stored, legacyRecord }) => {
      if (stored.present) {
        if (typeof stored.value !== 'string') throw new Error('Invalid saved file draft encoding');
        const decoded = record(JSON.parse(stored.value) as unknown, ['version', 'revision', 'attachments']);
        if (decoded.version !== 1) throw new Error('Unsupported saved file draft version');
        return validateFileState({ revision: decoded.revision, attachments: decoded.attachments });
      }
      const legacy = legacyRecord && typeof legacyRecord === 'object' && !Array.isArray(legacyRecord) &&
        Object.hasOwn(legacyRecord, 'attachments') ? (legacyRecord as { attachments: unknown }).attachments : [];
      const attachments = attachmentInputs(legacy);
      return validateFileState({
        revision: attachments.length ? 1 : 0,
        attachments: attachments.map(item => ({ ...item, revision: 1 })),
      });
    },
  },
};

class FileDraftAdapter implements FileDraft {
  readonly id: string;
  readonly sessionId: string;
  readonly purpose: DraftReference['purpose'];
  private baseSnapshot?: Readonly<ModuleDraftSnapshot>;
  private fieldSnapshot?: Readonly<FileState>;
  private snapshot?: FileDraftSnapshot;
  private readonly subscriptions = new Set<() => void>();
  private disposed = false;
  readonly reference: DraftReference;
  private readonly field: () => DraftSchemaScope<FileState>;
  private readonly base: () => ModuleDraft;

  constructor(
    reference: DraftReference,
    field: () => DraftSchemaScope<FileState>,
    base: () => ModuleDraft,
  ) {
    this.reference = reference;
    this.field = field;
    this.base = base;
    this.id = reference.id;
    this.sessionId = reference.sessionId;
    this.purpose = reference.purpose;
  }

  private active(): void {
    if (this.disposed) throw new Error('File draft is no longer active');
  }

  getSnapshot(): FileDraftSnapshot {
    this.active();
    const base = this.reference.getSnapshot();
    const field = this.field().getSnapshot();
    if (base !== this.baseSnapshot || field !== this.fieldSnapshot) {
      this.baseSnapshot = base;
      this.fieldSnapshot = field;
      this.snapshot = Object.freeze({ ...base, attachments: field.attachments });
    }
    return this.snapshot!;
  }

  subscribe(listener: () => void): () => void {
    this.active();
    const unsubscribeBase = this.reference.subscribe(listener);
    let unsubscribeField: () => void;
    try { unsubscribeField = this.field().subscribe(listener); }
    catch (error) { unsubscribeBase(); throw error; }
    const release = () => { unsubscribeBase(); unsubscribeField(); this.subscriptions.delete(release); };
    this.subscriptions.add(release);
    return release;
  }

  appendAttachments(values: readonly FileAttachment[]): void {
    this.active();
    const incoming = attachmentInputs(values);
    this.field().update(current => {
      const revision = current.revision + 1;
      const replaced = new Set(incoming.map(item => item.id));
      return {
        revision,
        attachments: [
          ...current.attachments.filter(item => !replaced.has(item.id)),
          ...incoming.map(item => ({ ...item, revision })),
        ],
      };
    });
  }

  removeAttachment(id: string): void {
    this.active();
    if (this.reference.getSnapshot().pending) throw new Error('消息正在提交，请等待回执后再修改附件。');
    this.field().update(current => ({ ...current, attachments: current.attachments.filter(item => item.id !== id) }));
  }

  block(reason: string): () => void {
    this.active();
    return this.base().block(reason);
  }

  dispose(): void {
    this.disposed = true;
    for (const release of [...this.subscriptions]) release();
    this.snapshot = this.baseSnapshot = this.fieldSnapshot = undefined;
  }
}

export class FileDrafts {
  private readonly drafts = new Map<string, FileDraftAdapter>();
  private disposed = false;
  private readonly schema: DraftSchemaHandle<FileState>;
  private readonly bind: ModuleStateRegistry['bindDraft'];

  constructor(schema: DraftSchemaHandle<FileState>, bind: ModuleStateRegistry['bindDraft']) {
    this.schema = schema;
    this.bind = bind;
  }

  prepare(reference: DraftReference): void {
    if (this.disposed) throw new Error('File drafts are no longer active');
    const previous = this.drafts.get(reference.id);
    if (previous) {
      if (previous.reference !== reference) throw new Error('File draft identity was replaced');
      return;
    }
    this.drafts.set(reference.id, new FileDraftAdapter(reference, () => {
      const field = this.schema.forDraft(reference);
      if (!field) throw new Error('File schema is unavailable for this draft');
      return field;
    }, () => this.bind(reference)));
  }

  get(reference: DraftReference): FileDraft | undefined {
    if (this.disposed) throw new Error('File drafts are no longer active');
    const scope = this.schema.forDraft(reference);
    if (!scope) return undefined;
    const draft = this.drafts.get(scope.draft.id);
    if (!draft || draft.reference !== scope.draft) throw new Error('File draft was not prepared');
    return draft;
  }

  dispose(): void {
    this.disposed = true;
    for (const draft of this.drafts.values()) draft.dispose();
    this.drafts.clear();
  }
}

export function registerFileDrafts(state: ModuleStateRegistry): FileDrafts {
  const waiting = new Set<DraftReference>();
  let drafts: FileDrafts | undefined;
  const prepare = (reference: DraftReference) => {
    if (drafts) drafts.prepare(reference);
    else waiting.add(reference);
  };
  const schema = state.registerDraft<FileState>({
    ...fileDraftSchema,
    create: reference => {
      const value = fileDraftSchema.create(reference);
      prepare(reference);
      return value;
    },
    persistence: {
      ...fileDraftSchema.persistence!,
      restore: (input, reference) => {
        const value = fileDraftSchema.persistence!.restore(input, reference);
        prepare(reference);
        return value;
      },
    },
  });
  drafts = state.register({
    id: 'file-drafts',
    create: () => {
      const service = new FileDrafts(schema, reference => state.bindDraft(reference));
      for (const reference of waiting) service.prepare(reference);
      waiting.clear();
      return service;
    },
    dispose: service => service.dispose(),
  }).get();
  return drafts;
}
