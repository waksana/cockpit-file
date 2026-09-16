import { createHash, type Hash } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActivateBackend, ModuleBackendContext, ModuleRequest, ModuleResponse, NativeObservation,
} from '@cockpit/module-api';
import { decodeMessageReference, isLocalFileReference, managedFileUrl } from '../shared/files.ts';
import { createFileStorage, FileStorageError, type FileLookup, type FileMetadata, type FileRange } from './storage.ts';
import { createMarkdownScanner, type MarkdownReference, type MarkdownScanner } from './scanner.ts';
import { createWorkLimit } from './work.ts';

interface MessageState {
  sessionId: string;
  messageId: string;
  cwd: string | null;
  owner: string;
  scanner: MarkdownScanner;
  hash: Hash;
  length: number;
  targets: Set<string>;
  touched: number;
  diagnosticsSeen: number;
}

function integer(config: Readonly<Record<string, unknown>>, key: string, fallback: number, maximum: number): number {
  const value = config[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${key} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function one(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\0-\x1f\x7f]/.test(value)) {
    throw Object.assign(new Error(`Invalid ${label}`), { statusCode: 400, code: 'INVALID_INPUT' });
  }
  return value;
}

function binary(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object' && value !== null
    && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === 'function';
}

function sourcePath(reference: string, cwd: string | null): string {
  if (!isLocalFileReference(reference)) throw new Error('Only local file references can be captured');
  if (reference.startsWith('file:')) return fileURLToPath(new URL(reference));
  const target = reference.split(/[?#]/, 1)[0]!;
  const decoded = decodeURIComponent(target.replace(/%(?![\da-fA-F]{2})/g, '%25'));
  if (/[\0-\x1f\x7f]/.test(decoded)) throw new Error('Invalid local file path');
  if (isAbsolute(decoded)) return resolve(decoded);
  if (!cwd || !isAbsolute(cwd)) throw new Error('Relative file reference has no native working directory');
  return resolve(cwd, decoded);
}

function errorResponse(error: unknown): ModuleResponse {
  if (!(error instanceof FileStorageError)) throw error;
  const status = ({
    INVALID_INPUT: 400, INVALID_SOURCE: 422, LIMIT_EXCEEDED: 413,
    CONFLICT: 409, PENDING: 202, BUSY: 503, CLOSED: 503, ABORTED: 409,
    SOURCE_NOT_FOUND: 404, NOT_FOUND: 404, SOURCE_UNREADABLE: 403, DISCARDED: 410, ACTIVITY_UNKNOWN: 409,
  } as Record<string, number>)[error.code] ?? 500;
  return { status, headers: { 'Cache-Control': 'no-store' },
    body: { code: error.code, error: error.message, ...(error.fileId ? { fileId: error.fileId } : {}),
      ...(error.committed ? { committed: true } : {}) } };
}

function fileHeaders(file: FileMetadata, download: boolean): Record<string, string> {
  const name = encodeURIComponent(file.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`);
  return {
    'Content-Type': file.mime,
    'Content-Length': String(file.size),
    'Content-Disposition': `${download || !file.inline ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
    ETag: `"${file.sha256}"`,
    'X-File-State': 'ready',
  };
}

function rangeOf(value: string, size: number): FileRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) throw new FileStorageError('INVALID_RANGE', 'Invalid byte range');
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1]) { start = Math.max(0, size - end); end = size - 1; }
  end = Math.min(end, size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw new FileStorageError('INVALID_RANGE', 'Range is outside the original');
  }
  return { start, end };
}

export const activate: ActivateBackend = async (context: ModuleBackendContext) => {
  const allowed = new Set(['maxBytes', 'maxConcurrent', 'maxPending', 'maxActiveMessages', 'maxCandidateChars', 'maxReferences']);
  for (const key of Object.keys(context.config)) if (!allowed.has(key)) throw new Error(`Unknown file configuration: ${key}`);
  const maxBytes = integer(context.config, 'maxBytes', 100 * 1024 * 1024, 1024 * 1024 * 1024);
  const maxConcurrent = integer(context.config, 'maxConcurrent', 4, 128);
  const maxPending = integer(context.config, 'maxPending', 64, 4096);
  const maxActiveMessages = integer(context.config, 'maxActiveMessages', 32, 1024);
  const maxCandidateChars = integer(context.config, 'maxCandidateChars', 8192, 1024 * 1024);
  if (maxCandidateChars < 16) throw new Error('maxCandidateChars must be at least 16');
  const maxReferences = integer(context.config, 'maxReferences', 256, 65536);
  const storage = await createFileStorage({ root: context.dataRoot, maxBytes, maxConcurrent });
  const work = createWorkLimit(maxConcurrent, maxPending, context.signal);
  const captures = new Set<string>();
  const messages = new Map<string, MessageState>();
  const keyOf = (sessionId: string, messageId: string) => JSON.stringify([sessionId, messageId]);
  let disposed = false;
  let closing: Promise<void> | undefined;
  const scanner = () => createMarkdownScanner({ maxCandidateChars, maxReferences });
  const report = (error: unknown) => context.report(error);
  const capture = (state: MessageState, references: MarkdownReference[]) => {
    for (const { target } of references) {
      if (disposed || state.targets.has(target) || !isLocalFileReference(target)) continue;
      if (state.targets.size >= maxReferences) { report(new Error('File reference limit reached')); break; }
      state.targets.add(target);
      let path: string;
      try { path = sourcePath(target, state.cwd); }
      catch (error) { report(error); continue; }
      const captureKey = JSON.stringify([state.sessionId, state.messageId, target]);
      if (captures.has(captureKey)) continue;
      captures.add(captureKey);
      void work.run(() => storage.capture(keyOf(state.sessionId, state.messageId), target, path, context.signal))
        .catch(report).finally(() => { captures.delete(captureKey); });
    }
  };
  const observe = ({ sessionId, cwd, event }: NativeObservation) => {
    if (disposed) return;
    const data = event.data;
    if (event.type === 'session.shutdown') {
      for (const [key, state] of messages) if (state.sessionId === sessionId) { state.scanner.finish(); messages.delete(key); }
      return;
    }
    const owner = event.agentId ?? event.parentToolCallId
      ?? (typeof data.agentId === 'string' ? data.agentId : typeof data.parentToolCallId === 'string' ? data.parentToolCallId : '');
    if (event.type === 'abort' || event.type === 'assistant.turn_end') {
      for (const [key, state] of messages) if (state.sessionId === sessionId && state.owner === owner) {
        state.scanner.finish(); messages.delete(key);
      }
      return;
    }
    const messageId = typeof data.messageId === 'string' && data.messageId ? data.messageId : undefined;
    if (!messageId) return;
    const key = keyOf(sessionId, messageId);
    let state = messages.get(key);
    const streaming = event.type === 'assistant.message_start' || event.type === 'assistant.message_delta';
    if (!state && streaming && event.ephemeral === true) {
      if (messages.size >= maxActiveMessages) { report(new Error('Active file scanner limit reached')); return; }
      state = { sessionId, messageId, cwd, owner, scanner: scanner(),
        hash: createHash('sha256'), length: 0, targets: new Set(), touched: Date.now(), diagnosticsSeen: 0 };
      messages.set(key, state);
    }
    // A complete event without a new stream is not evidence of a new message.
    if (!state) return;
    state.cwd = cwd;
    state.touched = Date.now();
    if (event.type === 'assistant.message_delta' && typeof data.deltaContent === 'string') {
      state.hash.update(data.deltaContent);
      state.length += data.deltaContent.length;
      capture(state, state.scanner.feed(data.deltaContent));
    } else if (event.type === 'assistant.message' && typeof data.content === 'string') {
      const prefix = data.content.slice(0, state.length);
      const samePrefix = prefix.length === state.length
        && createHash('sha256').update(prefix).digest('hex') === state.hash.copy().digest('hex');
      if (samePrefix) capture(state, state.scanner.feed(data.content.slice(state.length)));
      else {
        const correction = scanner();
        capture(state, correction.feed(data.content));
        for (const diagnostic of correction.diagnostics) report(new Error(diagnostic.message));
        correction.finish();
      }
      state.scanner.finish();
      messages.delete(key);
    }
    const diagnostics = state.scanner.diagnostics;
    for (const diagnostic of diagnostics.slice(state.diagnosticsSeen)) report(new Error(diagnostic.message));
    state.diagnosticsSeen = diagnostics.length;
  };
  const expire = setInterval(() => {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [key, state] of messages) if (state.touched < cutoff) {
      state.scanner.finish(); messages.delete(key);
      report(new Error('Inactive file scanner released without historical catch-up'));
    }
  }, 60_000);
  expire.unref();
  const dispose = () => {
    if (disposed) return closing;
    disposed = true;
    clearInterval(expire);
    for (const state of messages.values()) state.scanner.finish();
    messages.clear();
    work.dispose();
    context.signal.removeEventListener('abort', dispose);
    closing = storage.close();
    void closing.catch(report);
    return closing;
  };
  context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose();

  async function lookup(request: ModuleRequest, byMessage: boolean) {
    if (!byMessage) {
      const file = await storage.lookupFile(one(request.params.fileId, 'file ID'));
      return file.state === 'ready' && request.params.body !== basename(file.file.path)
        ? { state: 'no-record' as const } : file;
    }
    let decoded: ReturnType<typeof decodeMessageReference>;
    try { decoded = decodeMessageReference(one(request.params['*'], 'message reference')); }
    catch (error) { throw new FileStorageError('INVALID_INPUT', 'Invalid message reference', { cause: error }); }
    const found = await storage.lookupCapture(keyOf(decoded.origin.sessionId, decoded.origin.messageId), decoded.reference);
    return found.state === 'no-record' && captures.has(JSON.stringify([decoded.origin.sessionId, decoded.origin.messageId, decoded.reference]))
      ? { state: 'pending' as const } : found;
  }
  async function serve(request: ModuleRequest, byMessage: boolean, head: boolean): Promise<ModuleResponse> {
    try {
      const result: FileLookup | { state: 'pending' } = await lookup(request, byMessage);
      if (result.state === 'no-record') return { status: 404, headers: { 'Cache-Control': 'no-store', 'X-File-State': 'missing' } };
      if (result.state === 'pending') return { status: 202, headers: {
        'Cache-Control': 'no-store', 'Retry-After': '1', 'X-File-State': 'pending',
      } };
      if (result.state === 'failed') return { status: 422, headers: {
        'Cache-Control': 'no-store', 'X-File-State': 'failed',
      }, body: head ? undefined : { code: result.error.code, error: result.error.message } };
      const headers = fileHeaders(result.file, request.query.download === '1');
      if (head) return { headers };
      const rangeHeader = request.headers.range;
      const ifRange = request.headers['if-range'];
      let range: FileRange | undefined;
      if (typeof rangeHeader === 'string' && (!ifRange || ifRange === headers.ETag)) {
        try { range = rangeOf(rangeHeader, result.file.size); }
        catch (error) {
          if (!(error instanceof FileStorageError) || error.code !== 'INVALID_RANGE') throw error;
          return { status: 416, headers: { 'Content-Range': `bytes */${result.file.size}`, 'Cache-Control': 'no-store' } };
        }
      }
      const opened = await storage.openFile(result.file.id, range);
      if (range) {
        headers['Content-Range'] = `bytes ${opened.start}-${opened.end}/${opened.file.size}`;
        headers['Content-Length'] = String(opened.length);
      }
      return { status: range ? 206 : 200, headers, body: opened.stream };
    } catch (error) { return errorResponse(error); }
  }

  return {
    publicConfig: { maxBytes, nativePathPrefix: `${storage.root}/files/` },
    events: {
      types: ['assistant.message_start', 'assistant.message_delta', 'assistant.message', 'assistant.turn_end', 'abort', 'session.shutdown'],
      handle: observe,
    },
    dispose,
    routes: [
      { method: 'DELETE', path: '/uploads/:operationId',
        handler: async request => {
          try {
            await storage.discardUpload(request.params.operationId!);
            return { status: 204, headers: { 'Cache-Control': 'no-store' } };
          } catch (error) {
            if (request.signal.aborted) report(error);
            return errorResponse(error);
          }
        } },
      { method: 'POST', path: '/upload', body: 'stream', bodyLimit: maxBytes,
        handler: async request => {
          if (!binary(request.body)) return { status: 400, body: { error: 'Binary file body required', code: 'INVALID_INPUT' } };
          const name = one(request.query.name, 'file name');
          const operationId = one(request.query.operationId, 'upload operation ID');
          try {
            const body = request.body;
            const file = await work.run(() => storage.upload(operationId, body, name,
              typeof request.headers['x-file-mime'] === 'string' ? request.headers['x-file-mime'] : undefined, request.signal), request.signal);
            return { headers: { 'Cache-Control': 'no-store' }, body: {
              fileId: file.id, url: managedFileUrl(context.apiBase, file.id, basename(file.path)),
              name: file.name, mime: file.mime, size: file.size, sha256: file.sha256,
              attachment: { type: 'file', path: file.path, displayName: file.name },
            } };
          } catch (error) { return errorResponse(error); }
        } },
      { method: 'GET', path: '/files/:fileId/:body', handler: request => serve(request, false, false) },
      { method: 'HEAD', path: '/files/:fileId/:body', handler: request => serve(request, false, true) },
      { method: 'GET', path: '/messages/*', handler: request => serve(request, true, false) },
      { method: 'HEAD', path: '/messages/*', handler: request => serve(request, true, true) },
    ],
  };
};
