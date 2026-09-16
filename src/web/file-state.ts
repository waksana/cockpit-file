import type { ComposerContext, DraftAttachment, ModuleDraft, ModuleFrontendContext } from '@cockpit/module-api';
import { fileRequestPath, managedFileUrl, nativeFileUrl } from '../shared/files.ts';

export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;

type Request = ModuleFrontendContext['request'];
type Report = ModuleFrontendContext['report'];
type UploadStatus = 'uploading' | 'failed' | 'reselect' | 'ready';

export interface UploadItem {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly status: UploadStatus;
  readonly error?: string;
}

export interface UploadSnapshot {
  readonly items: readonly UploadItem[];
  readonly error?: string;
}

interface UploadEntry extends UploadItem {
  file?: File;
  result?: DraftAttachment;
  controller?: AbortController;
}

interface UploadScope {
  draft?: ModuleDraft;
  entries: UploadEntry[];
  listeners: Set<() => void>;
  snapshot: UploadSnapshot;
  release?: () => void;
  error?: string;
}

interface PendingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface UploadOptions {
  request: Request;
  report: Report;
  apiBase: string;
  nativePathPrefix: string;
  maxBytes?: number;
  storage?: PendingStorage;
  operationId?: () => string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'File operation failed';
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('File service response is too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function uploadError(response: Response): Promise<Error> {
  let detail = '';
  try {
    const text = await readBounded(response, 8_192);
    const json: unknown = JSON.parse(text);
    if (json && typeof json === 'object' && 'error' in json) {
      const error = json.error;
      if (typeof error === 'string') detail = error;
      else if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
        detail = error.message;
      }
    }
  } catch {
    // Invalid or oversized errors must not hide the HTTP failure.
  }
  const outcome = response.status === 202 ? 'Upload is still pending' : 'Upload failed';
  return new Error(detail ? `${outcome} (${response.status}): ${detail.slice(0, 500)}` : `${outcome} (HTTP ${response.status})`);
}

export class UploadStore {
  private readonly scopes = new Map<string, UploadScope>();
  private readonly options: UploadOptions;
  private readonly storageKey: string;
  private disposed = false;

  constructor(options: UploadOptions) {
    this.options = options;
    this.storageKey = `cf-pending:${options.apiBase}`;
    this.restore();
  }

  private scope(sessionId: string): UploadScope {
    let scope = this.scopes.get(sessionId);
    if (!scope) {
      scope = { entries: [], listeners: new Set(), snapshot: { items: [] } };
      this.scopes.set(sessionId, scope);
    }
    return scope;
  }

  snapshot(draft: ModuleDraft): UploadSnapshot {
    return this.scope(draft.sessionId).snapshot;
  }

  subscribe(draft: ModuleDraft, listener: () => void): () => void {
    if (this.disposed) return () => {};
    const scope = this.bind(draft);
    scope.listeners.add(listener);
    return () => scope.listeners.delete(listener);
  }

  private bind(draft: ModuleDraft): UploadScope {
    const scope = this.scope(draft.sessionId);
    if (!scope.draft || scope.entries.length === 0) scope.draft = draft;
    const attached = new Set(scope.draft.getSnapshot().attachments.map(item => item.id));
    const restored = scope.entries.filter(entry => entry.status !== 'reselect' || !attached.has(`cf-upload:${entry.id}`));
    if (restored.length !== scope.entries.length) {
      scope.entries = restored;
      this.publish(scope);
    }
    if (scope.entries.length && !scope.release) scope.release = scope.draft.block('请等待文件上传完成，或移除未完成的附件');
    if (!scope.entries.length && scope.release) {
      scope.release();
      scope.release = undefined;
    }
    return scope;
  }

  receive(files: readonly File[], context: ComposerContext): void {
    if (this.disposed || files.length === 0) return;
    const scope = this.bind(context.draft);
    if (context.disabled || context.operation !== 'prompt') {
      this.reject(scope, 'Files can only be attached to an available prompt.');
      return;
    }
    if (context.draft.getSnapshot().attachments.length + scope.entries.length + files.length > MAX_ATTACHMENTS) {
      this.reject(scope, `A prompt supports at most ${MAX_ATTACHMENTS} attachments. Remove a file before adding more.`);
      return;
    }
    let entries: UploadEntry[];
    try {
      entries = files.map(file => ({
        id: (this.options.operationId ?? (() => crypto.randomUUID()))(),
        name: file.name || 'file', size: file.size, status: 'uploading', file,
      }));
    } catch {
      this.reject(scope, 'Cannot create an upload identity. Use a secure browser connection and try again.');
      return;
    }
    // This guard belongs to the captured draft, not the currently mounted view.
    scope.release ??= scope.draft!.block('请等待文件上传完成，或移除未完成的附件');
    scope.entries.push(...entries);
    scope.error = undefined;
    this.publish(scope);
    for (const entry of entries) void this.upload(scope, entry);
  }

  retry(draft: ModuleDraft, id: string): void {
    if (this.disposed) return;
    const scope = this.bind(draft);
    const entry = scope.entries.find(item => item.id === id);
    if (!entry || entry.status !== 'failed' || (!entry.file && !entry.result)) return;
    this.replace(scope, entry, { ...entry, status: entry.result ? 'ready' : 'uploading', error: undefined });
    if (entry.result) {
      this.flush(scope);
      this.publish(scope);
      return;
    }
    const replacement = scope.entries.find(item => item.id === id)!;
    this.publish(scope);
    void this.upload(scope, replacement);
  }

  remove(draft: ModuleDraft, id: string): void {
    if (this.disposed) return;
    const scope = this.bind(draft);
    const entry = scope.entries.find(item => item.id === id);
    if (!entry) return;
    scope.entries = scope.entries.filter(item => item !== entry);
    entry.controller?.abort();
    this.flush(scope);
    this.publish(scope);
  }

  private reject(scope: UploadScope, error: string): void {
    scope.error = error;
    this.options.report(new Error(error));
    this.publish(scope);
  }

  private replace(scope: UploadScope, entry: UploadEntry, replacement: UploadEntry): void {
    const index = scope.entries.indexOf(entry);
    if (index !== -1) scope.entries[index] = replacement;
  }

  private async upload(scope: UploadScope, entry: UploadEntry): Promise<void> {
    if (this.disposed || !entry.file || !scope.entries.includes(entry)) return;
    const controller = new AbortController();
    entry.controller = controller;
    try {
      const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
      if (entry.size > maxBytes) throw new Error(`File exceeds the ${formatBytes(maxBytes)} upload limit.`);
      const response = await this.options.request(
        `/upload?name=${encodeURIComponent(entry.name)}&operationId=${encodeURIComponent(entry.id)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', 'x-file-mime': entry.file.type || 'application/octet-stream' },
          body: entry.file,
          signal: controller.signal,
        },
      );
      if (!response.ok || response.status === 202) throw await uploadError(response);
      const value: unknown = JSON.parse(await readBounded(response, 65_536));
      const result = this.attachment(value, entry);
      if (this.disposed || controller.signal.aborted || !scope.entries.includes(entry)) return;
      this.replace(scope, entry, { ...entry, file: undefined, controller: undefined, result, status: 'ready' });
      this.flush(scope);
      this.publish(scope);
    } catch (error) {
      if (this.disposed || controller.signal.aborted || !scope.entries.includes(entry)) return;
      this.replace(scope, entry, { ...entry, controller: undefined, status: 'failed', error: message(error) });
      this.options.report(error);
      this.publish(scope);
    }
  }

  private attachment(value: unknown, entry: UploadEntry): DraftAttachment {
    if (!value || typeof value !== 'object') throw new Error('Invalid upload response');
    const data = value as Record<string, unknown>;
    const fileId = data.fileId;
    if (typeof fileId !== 'string') throw new Error('Upload response is missing its file ID');
    const attachment = data.attachment;
    // The host may add an origin/deployment prefix not present in the upload response URL.
    if (!attachment || typeof attachment !== 'object') throw new Error('Invalid uploaded file attachment');
    const native = attachment as Record<string, unknown>;
    if (native.type !== 'file' || typeof native.path !== 'string' ||
        nativeFileUrl(native.path, this.options.nativePathPrefix, this.options.apiBase) === null ||
        (native.displayName !== undefined && typeof native.displayName !== 'string')) {
      throw new Error('Upload response is missing its managed native attachment');
    }
    const url = managedFileUrl(this.options.apiBase, fileId, native.path.split('/').at(-1)!);
    if (nativeFileUrl(native.path, this.options.nativePathPrefix, this.options.apiBase) !== url) {
      throw new Error('Upload response is missing its managed native attachment');
    }
    return {
      id: `cf-upload:${entry.id}`,
      value: { type: 'file', path: native.path, displayName: native.displayName as string | undefined ?? entry.name },
    };
  }

  private flush(scope: UploadScope): void {
    const ready: DraftAttachment[] = [];
    for (const entry of scope.entries) {
      if (entry.status !== 'ready' || !entry.result) break;
      ready.push(entry.result);
    }
    if (ready.length) {
      try {
        const existing = new Set(scope.draft!.getSnapshot().attachments.map(item => item.id));
        const missing = ready.filter(item => !existing.has(item.id));
        if (missing.length) scope.draft!.appendAttachments(missing);
      } catch (error) {
        const detail = `Could not add uploaded files to the draft: ${message(error)}`;
        for (let index = 0; index < ready.length; index++) {
          scope.entries[index] = { ...scope.entries[index]!, status: 'failed', error: detail };
        }
        this.options.report(error);
        return;
      }
      scope.entries.splice(0, ready.length);
    }
    if (scope.entries.length === 0) {
      scope.release?.();
      scope.release = undefined;
    }
  }

  private publish(scope: UploadScope): void {
    scope.snapshot = {
      items: scope.entries.map(({ id, name, size, status, error }) => ({ id, name, size, status, ...(error ? { error } : {}) })),
      ...(scope.error ? { error: scope.error } : {}),
    };
    this.persist();
    for (const listener of scope.listeners) listener();
  }

  private restore(): void {
    try {
      const raw = this.options.storage?.getItem(this.storageKey);
      if (!raw || raw.length > 1_048_576) return;
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value)) return;
      for (const item of value.slice(0, 2_000)) {
        if (!item || typeof item !== 'object' || typeof item.sessionId !== 'string' ||
            typeof item.id !== 'string' || typeof item.name !== 'string' ||
            typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0) continue;
        const scope = this.scope(item.sessionId);
        if (scope.entries.length >= MAX_ATTACHMENTS || scope.entries.some(entry => entry.id === item.id)) continue;
        scope.entries.push({
          id: item.id, name: item.name, size: item.size, status: 'reselect',
          error: 'Upload interrupted by refresh. Remove this item and select the local file again.',
        });
        scope.snapshot = { items: scope.entries.map(({ id, name, size, status, error }) => ({ id, name, size, status, error })) };
      }
    } catch (error) {
      this.options.report(error);
    }
  }

  private persist(): void {
    if (!this.options.storage) return;
    const items = [...this.scopes].flatMap(([sessionId, scope]) =>
      scope.entries.map(({ id, name, size }) => ({ sessionId, id, name, size })),
    );
    try {
      if (items.length) this.options.storage.setItem(this.storageKey, JSON.stringify(items));
      else this.options.storage.removeItem(this.storageKey);
    } catch (error) {
      this.options.report(error);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.persist();
    for (const scope of this.scopes.values()) {
      scope.listeners.clear();
      for (const entry of scope.entries) entry.controller?.abort();
      scope.release?.();
      scope.release = undefined;
      scope.entries = [];
    }
    this.scopes.clear();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

export function previewKind(mime: string): 'image' | 'video' | 'audio' | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return null;
}

export interface ProbeSnapshot {
  readonly status: 'pending' | 'ready' | 'unavailable';
  readonly round: number;
  readonly deadline: number;
  readonly mime?: string;
  readonly size?: number;
  readonly preview?: 'pending' | 'ready' | 'failed';
  readonly error?: string;
}

export interface ProbeClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface ProbeEntry {
  snapshot: ProbeSnapshot;
  listeners: Set<() => void>;
  controller?: AbortController;
  timeout?: unknown;
  retryTimer?: unknown;
  nextAt: number;
  attempts: number;
}

const browserClock: ProbeClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class FileProbes {
  private readonly entries = new Map<string, ProbeEntry>();
  private readonly request: Request;
  private readonly apiBase: string;
  private readonly clock: ProbeClock;
  private visible = true;
  private disposed = false;

  constructor(request: Request, apiBase: string, clock: ProbeClock = browserClock) {
    this.request = request;
    this.apiBase = apiBase;
    this.clock = clock;
  }

  private entry(url: string): ProbeEntry {
    let entry = this.entries.get(url);
    if (!entry) {
      fileRequestPath(this.apiBase, url);
      entry = {
        snapshot: { status: 'pending', round: 0, deadline: this.clock.now() + 5_000 },
        listeners: new Set(), attempts: 0, nextAt: this.clock.now(),
      };
      this.entries.set(url, entry);
    }
    return entry;
  }

  snapshot(url: string): ProbeSnapshot {
    return this.entry(url).snapshot;
  }

  subscribe(url: string, listener: () => void): () => void {
    if (this.disposed) return () => {};
    const entry = this.entry(url);
    entry.listeners.add(listener);
    this.resume(url, entry);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) this.pause(entry);
    };
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    for (const [url, entry] of this.entries) {
      if (visible) this.resume(url, entry);
      else this.pause(entry);
    }
  }

  retry(url: string): void {
    if (this.disposed) return;
    const entry = this.entry(url);
    this.pause(entry);
    entry.snapshot = { status: 'pending', round: entry.snapshot.round + 1, deadline: this.clock.now() + 5_000 };
    entry.attempts = 0;
    entry.nextAt = this.clock.now();
    this.notify(entry);
    this.resume(url, entry);
  }

  mediaReady(url: string, round: number): void {
    this.mediaResult(url, round, true);
  }

  mediaFailed(url: string, round: number): void {
    this.mediaResult(url, round, false);
  }

  private mediaResult(url: string, round: number, ready: boolean): void {
    if (this.disposed) return;
    const entry = this.entries.get(url);
    if (!entry || entry.snapshot.round !== round || entry.snapshot.status !== 'ready' ||
        (entry.snapshot.preview !== 'pending' && (ready || entry.snapshot.preview !== 'ready'))) return;
    if (ready && this.clock.now() >= entry.snapshot.deadline) {
      this.expire(entry);
      return;
    }
    this.pause(entry);
    entry.snapshot = {
      ...entry.snapshot, preview: ready ? 'ready' : 'failed',
      ...(ready ? {} : { error: 'Preview unavailable. You can still download the original file.' }),
    };
    this.notify(entry);
  }

  private active(entry: ProbeEntry): boolean {
    return !this.disposed && this.visible && entry.listeners.size > 0;
  }

  private waiting(entry: ProbeEntry): boolean {
    return entry.snapshot.status === 'pending' || entry.snapshot.preview === 'pending';
  }

  private resume(url: string, entry: ProbeEntry): void {
    if (!this.active(entry) || !this.waiting(entry)) return;
    const remaining = entry.snapshot.deadline - this.clock.now();
    if (remaining <= 0) {
      this.expire(entry);
      return;
    }
    entry.timeout ??= this.clock.setTimeout(() => this.expire(entry), remaining);
    if (entry.snapshot.status !== 'pending' || entry.controller || entry.retryTimer !== undefined) return;
    const delay = entry.nextAt - this.clock.now();
    if (delay > 0) {
      entry.retryTimer = this.clock.setTimeout(() => {
        entry.retryTimer = undefined;
        this.resume(url, entry);
      }, delay);
    } else {
      void this.check(url, entry);
    }
  }

  private expire(entry: ProbeEntry): void {
    this.pause(entry);
    if (!this.waiting(entry)) return;
    entry.snapshot = entry.snapshot.status === 'ready'
      ? { ...entry.snapshot, preview: 'failed', error: 'Preview did not load within five seconds. Download or retry.' }
      : { ...entry.snapshot, status: 'unavailable', error: 'File unavailable after five seconds. Retry to check again.' };
    this.notify(entry);
  }

  private async check(url: string, entry: ProbeEntry): Promise<void> {
    const controller = new AbortController();
    entry.controller = controller;
    try {
      const response = await this.request(fileRequestPath(this.apiBase, url), {
        method: 'HEAD', cache: 'no-store', signal: controller.signal,
      });
      if (controller.signal.aborted || !this.active(entry) || entry.controller !== controller) return;
      entry.controller = undefined;
      if (this.clock.now() >= entry.snapshot.deadline) {
        this.expire(entry);
        return;
      }
      if (response.status === 200) {
        const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
        const length = response.headers.get('content-length');
        const size = length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
        entry.snapshot = {
          ...entry.snapshot, status: 'ready', mime,
          ...(size !== undefined && Number.isSafeInteger(size) ? { size } : {}),
          ...(previewKind(mime) ? { preview: 'pending' } : {}),
        };
        if (!entry.snapshot.preview) this.pause(entry);
        this.notify(entry);
      } else if ((response.status === 202 || response.status === 404) &&
                 response.headers.get('x-cockpit-file-state') !== 'failed') {
        entry.nextAt = this.clock.now() + Math.min(150 * 2 ** entry.attempts++, 1_000);
        this.resume(url, entry);
      } else {
        this.fail(entry, response.status === 401 || response.status === 403
          ? 'You do not have access to this file.'
          : `File unavailable (HTTP ${response.status}).`);
      }
    } catch (error) {
      if (controller.signal.aborted || !this.active(entry) || entry.controller !== controller) return;
      entry.controller = undefined;
      this.fail(entry, `File check failed: ${message(error)}`);
    }
  }

  private fail(entry: ProbeEntry, error: string): void {
    this.pause(entry);
    entry.snapshot = { ...entry.snapshot, status: 'unavailable', error };
    this.notify(entry);
  }

  private notify(entry: ProbeEntry): void {
    if (!this.disposed) for (const listener of entry.listeners) listener();
  }

  private pause(entry: ProbeEntry): void {
    entry.controller?.abort();
    entry.controller = undefined;
    if (entry.timeout !== undefined) this.clock.clearTimeout(entry.timeout);
    if (entry.retryTimer !== undefined) this.clock.clearTimeout(entry.retryTimer);
    entry.timeout = undefined;
    entry.retryTimer = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      this.pause(entry);
      entry.listeners.clear();
    }
    this.entries.clear();
  }
}
