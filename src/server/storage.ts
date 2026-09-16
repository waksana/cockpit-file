import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';

export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const BLOCK_BYTES = 64 * 1024;
const PREFIX_BYTES = 4096;
const ID = /^f_[a-f0-9]{64}$/;
const BODY = /^body(?:\.[a-z0-9]{1,16})?$/;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const activeOperations = new Map<string, string>();
const uploadTasks = new Map<string, {
  kind: 'upload' | 'discard'; controller: AbortController; promise: Promise<unknown>;
}>();
const STAMP_FIELDS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const;

export interface FileMetadata {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  path: string;
  createdAt: string;
  inline: boolean;
}

export interface StoredFailure { code: string; message: string }
export type FileLookup =
  | { state: 'no-record' }
  | { state: 'pending'; fileId: string }
  | { state: 'failed'; fileId: string; error: StoredFailure }
  | { state: 'ready'; file: FileMetadata };

export type FileInput = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
export interface FileRange { start: number; end?: number }
export interface OpenedFile {
  file: FileMetadata;
  stream: Readable;
  start: number;
  end: number;
  length: number;
}
export interface FileStorageOptions { root: string; maxBytes?: number; maxConcurrent?: number }
export interface FileStorage {
  readonly root: string;
  readonly maxBytes: number;
  upload(operationId: string, stream: FileInput, name: string, mime?: string, signal?: AbortSignal): Promise<FileMetadata>;
  discardUpload(operationId: string): Promise<void>;
  capture(messageKey: string, reference: string, sourcePath: string | readonly string[], signal?: AbortSignal): Promise<FileMetadata>;
  lookupFile(fileId: string): Promise<FileLookup>;
  lookupUpload(operationId: string): Promise<FileLookup>;
  lookupCapture(messageKey: string, reference: string): Promise<FileLookup>;
  openFile(fileId: string, range?: FileRange): Promise<OpenedFile>;
  close(): Promise<void>;
}

export class FileStorageError extends Error {
  readonly code: string;
  readonly fileId?: string;
  readonly committed: boolean;
  constructor(code: string, message: string, options?: { cause?: unknown; fileId?: string; committed?: boolean }) {
    super(message, { cause: options?.cause });
    this.name = 'FileStorageError';
    this.code = code;
    this.fileId = options?.fileId;
    this.committed = options?.committed ?? false;
  }
}

type Identity = { kind: 'upload'; operationId: string; name: string }
  | { kind: 'capture'; messageKey: string; reference: string; name: string };
type BodyStamp = Record<typeof STAMP_FIELDS[number], string>;
type OperationOwner = { pid: number; operation: string };
type DiskMetadata = Omit<FileMetadata, 'path'> & { body: string; bodyStamp: BodyStamp; identity: Identity; version: 2 };
type State = { state: 'pending'; owner: OperationOwner } | { state: 'failed'; error: StoredFailure };
type Discard = { version: 1; id: string; owner: OperationOwner };
type CaptureSource = { paths: readonly string[] };

function failure(code: string, message: string, cause?: unknown): FileStorageError {
  return new FileStorageError(code, message, { cause });
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
function asFailure(error: unknown): FileStorageError {
  return error instanceof FileStorageError ? error : failure('IO_ERROR', 'File storage operation failed', error);
}
function key(value: string, field: string): string {
  if (typeof value !== 'string' || !value || value.length > 16384 || value.includes('\0')) {
    throw failure('INVALID_INPUT', `${field} must be a nonempty string of at most 16384 characters`);
  }
  return value;
}
function uploadKey(value: string): string {
  key(value, 'operationId');
  if (/[\x00-\x20\x7f/\\:]/.test(value) || value === '.' || value === '..' || ID.test(value)) {
    throw failure('INVALID_INPUT', 'Expected an upload operation ID, not a path or managed file ID');
  }
  return value;
}
function nameOf(value: string): string {
  if (typeof value !== 'string' || value.length > 16384) throw failure('INVALID_INPUT', 'Invalid file name');
  return basename(value.replaceAll('\\', '/')).normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 255) || 'file';
}
function identityId(identity: Identity): string {
  const parts = identity.kind === 'upload'
    ? ['upload', identity.operationId]
    : ['capture', identity.messageKey, identity.reference];
  return `f_${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}
function checkId(id: string): void {
  if (!ID.test(id)) throw failure('INVALID_INPUT', 'Invalid managed file identity');
}
function fdPath(handle: FileHandle, child?: string): string {
  return child ? `/proc/self/fd/${handle.fd}/${child}` : `/proc/self/fd/${handle.fd}`;
}
async function privateHandle(handle: FileHandle, directory: boolean): Promise<FileHandle> {
  const stat = await handle.stat();
  if ((directory ? !stat.isDirectory() : !stat.isFile()) ||
      stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw failure('UNSAFE_STORAGE', 'Storage entries must be private, owned regular files or directories');
  }
  return handle;
}
async function directory(path: string): Promise<FileHandle> {
  const handle = await open(path, DIRECTORY_FLAGS);
  try { return await privateHandle(handle, true); }
  catch (error) { await handle.close(); throw error; }
}
async function readJson(parent: FileHandle, name: string): Promise<unknown> {
  const handle = await open(fdPath(parent, name), READ_FLAGS);
  try {
    await privateHandle(handle, false);
    const stat = await handle.stat();
    if (stat.size > 65536) throw failure('CORRUPT', 'Stored metadata exceeds its size limit');
    try { return JSON.parse(await handle.readFile('utf8')) as unknown; }
    catch (error) {
      if (error instanceof SyntaxError) throw failure('CORRUPT', 'Stored metadata is not valid JSON', error);
      throw error;
    }
  } finally { await handle.close(); }
}
async function writeJson(parent: FileHandle, name: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 65536) throw failure('INVALID_INPUT', 'Metadata exceeds its 65536-byte limit');
  const temporary = `.record-${randomUUID()}`;
  const path = fdPath(parent, temporary);
  try {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(encoded); await handle.sync(); }
    finally { await handle.close(); }
    await rename(path, fdPath(parent, name));
    await parent.sync();
  } finally { await rm(path, { force: true }); }
}
async function removeTree(parent: FileHandle, name: string): Promise<void> {
  let handle: FileHandle;
  try { handle = await directory(fdPath(parent, name)); }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    if (!hasCode(error, 'ENOTDIR') && !hasCode(error, 'ELOOP')) throw error;
    try { await unlink(fdPath(parent, name)); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    return;
  }
  try {
    // Recurse through pinned descriptors, never through replaceable path prefixes.
    for (const child of await readdir(fdPath(handle))) await removeTree(handle, child);
    await handle.sync();
  } finally { await handle.close(); }
  try { await rmdir(fdPath(parent, name)); }
  catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function bodyStamp(stat: BigIntStats): BodyStamp {
  return {
    dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
  };
}
function validStamp(value: unknown): value is BodyStamp {
  return object(value) && STAMP_FIELDS.every(field =>
    typeof value[field] === 'string' && /^\d{1,32}$/.test(value[field]));
}
async function validateBody(handle: FileHandle, saved: Pick<DiskMetadata, 'size' | 'bodyStamp'>): Promise<void> {
  await privateHandle(handle, false);
  const actual = bodyStamp(await handle.stat({ bigint: true }));
  if (actual.size !== String(saved.size) || STAMP_FIELDS.some(field => actual[field] !== saved.bodyStamp[field])) {
    throw failure('CORRUPT', 'Stored original identity or timestamps changed after publication');
  }
}
function parseIdentity(value: unknown): Identity {
  if (!object(value) || typeof value.name !== 'string') throw failure('CORRUPT', 'Invalid stored identity');
  if (value.kind === 'upload' && typeof value.operationId === 'string') {
    return { kind: 'upload', operationId: key(value.operationId, 'operationId'), name: value.name };
  }
  if (value.kind === 'capture' && typeof value.messageKey === 'string' && typeof value.reference === 'string') {
    return { kind: 'capture', messageKey: key(value.messageKey, 'messageKey'), reference: key(value.reference, 'reference'), name: value.name };
  }
  throw failure('CORRUPT', 'Invalid stored identity');
}
const INLINE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
  'audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/mp4', 'video/ogg', 'video/mp4', 'video/webm',
]);
function svgPrefix(prefix: Buffer): boolean {
  let text = prefix.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (text.startsWith('<?xml ')) {
    const end = text.indexOf('?>');
    if (end < 0) return false;
    text = text.slice(end + 2).trimStart();
  }
  while (text.startsWith('<!--')) {
    const end = text.indexOf('-->');
    if (end < 0) return false;
    text = text.slice(end + 3).trimStart();
  }
  // MIME recognition only: SVG is rendered as an image, never inserted as page markup.
  return /^<svg(?:[\t\n\r ][^>]*|\/?)>/.test(text);
}
function sniff(prefix: Buffer): string {
  if (prefix.length >= 24 && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      prefix.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'image/jpeg';
  if (prefix.length >= 10 && /^GIF8[79]a$/.test(prefix.toString('ascii', 0, 6))) return 'image/gif';
  if (prefix.length >= 16 && prefix.toString('ascii', 0, 4) === 'RIFF') {
    if (prefix.toString('ascii', 8, 12) === 'WEBP' && /^VP8[ LX]$/.test(prefix.toString('ascii', 12, 16))) return 'image/webp';
    if (prefix.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  }
  if (prefix.length >= 12 && prefix.toString('ascii', 4, 8) === 'ftyp') {
    const boxSize = prefix.readUInt32BE(0);
    if (boxSize >= 16 && boxSize <= prefix.length) {
      const brands = prefix.toString('ascii', 8, boxSize);
      if (/avif|avis/.test(brands)) return 'image/avif';
      if (/M4A |M4B /.test(brands)) return 'audio/mp4';
      if (/isom|iso[2-9]|mp4[12]|avc1|M4V /.test(brands)) return 'video/mp4';
    }
  }
  if (prefix.length >= 32 && prefix.toString('ascii', 0, 4) === 'OggS') {
    if (prefix.includes(Buffer.from('theora'))) return 'video/ogg';
    if (prefix.includes(Buffer.from('OpusHead')) || prefix.includes(Buffer.from('vorbis'))) return 'audio/ogg';
  }
  if (prefix.length >= 10 && prefix.toString('ascii', 0, 3) === 'ID3' &&
      (prefix[3] === 2 || prefix[3] === 3 || prefix[3] === 4)) return 'audio/mpeg';
  if (prefix.length >= 4 && prefix[0] === 0xff && ((prefix[1] ?? 0) & 0xe0) === 0xe0 &&
      ((prefix[1] ?? 0) & 0x06) !== 0 && ((prefix[2] ?? 0) & 0xf0) !== 0xf0 &&
      ((prefix[2] ?? 0) & 0xf0) !== 0 && ((prefix[2] ?? 0) & 0x0c) !== 0x0c) return 'audio/mpeg';
  if (prefix.length >= 12 && prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
      prefix.includes(Buffer.from('webm'))) return 'video/webm';
  if (svgPrefix(prefix)) return 'image/svg+xml';
  return 'application/octet-stream';
}
function bodyName(name: string, mime: string): string {
  const canonical: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'image/avif': '.avif', 'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg',
    'image/svg+xml': '.svg',
    'audio/mp4': '.m4a', 'video/ogg': '.ogv', 'video/mp4': '.mp4', 'video/webm': '.webm',
  };
  const extension = extname(name).toLowerCase();
  return `body${canonical[mime] ?? (/^\.[a-z0-9]{1,16}$/.test(extension) ? extension : '')}`;
}
function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw failure('ABORTED', 'File operation aborted', signal.reason);
}
async function* sourceBytes(handle: FileHandle): AsyncGenerator<Uint8Array> {
  const buffer = Buffer.alloc(BLOCK_BYTES);
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (!bytesRead) return;
    yield buffer.subarray(0, bytesRead);
  }
}

async function consume(input: FileInput, maxBytes: number, signal: AbortSignal, output?: FileHandle) {
  const reader = 'getReader' in input ? input.getReader() : undefined;
  const iterator: AsyncIterator<Uint8Array> = reader ? {
    async next() {
      const item = await reader.read();
      return item.done ? { done: true, value: undefined } : { done: false, value: item.value };
    },
    return() {
      const cancelled = reader.cancel();
      reader.releaseLock();
      return cancelled.then(() => ({ done: true, value: undefined }));
    },
  } : (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  const hash = createHash('sha256');
  const prefix = Buffer.alloc(PREFIX_BYTES);
  let prefixSize = 0;
  let size = 0;
  let rejectAbort: ((error: FileStorageError) => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abortFailure = failure('ABORTED', 'File operation aborted');
  const onAbort = () => rejectAbort?.(abortFailure);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    aborted(signal);
    while (true) {
      const item = await Promise.race([iterator.next(), cancellation]);
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw failure('INVALID_INPUT', 'File streams must contain byte chunks');
      const chunk = item.value;
      if (chunk.byteLength > maxBytes - size) throw failure('LIMIT_EXCEEDED', `File exceeds the ${maxBytes}-byte limit`);
      size += chunk.byteLength;
      for (let offset = 0; offset < chunk.byteLength; offset += BLOCK_BYTES) {
        aborted(signal);
        const block = Buffer.from(chunk.subarray(offset, Math.min(offset + BLOCK_BYTES, chunk.byteLength)));
        hash.update(block);
        if (prefixSize < PREFIX_BYTES) {
          const bytes = Math.min(PREFIX_BYTES - prefixSize, block.byteLength);
          prefix.set(block.subarray(0, bytes), prefixSize);
          prefixSize += bytes;
        }
        if (output) {
          let written = 0;
          while (written < block.byteLength) {
            aborted(signal);
            const result = await output.write(block, written, block.byteLength - written);
            if (!result.bytesWritten) throw failure('IO_ERROR', 'File write made no progress');
            written += result.bytesWritten;
          }
        }
      }
    }
    aborted(signal);
    return { size, sha256: hash.digest('hex'), mime: sniff(prefix.subarray(0, prefixSize)) };
  } finally {
    try {
      // A stalled caller-owned arbitrary iterator cannot be forcibly cancelled.
      if (input instanceof Readable) input.destroy();
      const returned = iterator.return?.();
      if (returned) {
        try { await Promise.race([returned, cancellation]); }
        catch (error) { if (error !== abortFailure) throw error; }
      }
    } finally { signal.removeEventListener('abort', onAbort); }
  }
}

/**
 * Linux storage uses pinned directory descriptors (/proc/self/fd) so serving never
 * follows a replacement directory or body symlink. Empty originals are valid.
 * SHA-256 is computed at ingestion; reads check the committed inode/timestamp stamp
 * without a full rehash. Unknown owners yield explicit interrupted/unknown errors,
 * not perpetual pending. No lookup or startup path reopens a capture source.
 */
export async function createFileStorage(options: FileStorageOptions): Promise<FileStorage> {
  if (typeof options.root !== 'string' || !isAbsolute(options.root) || resolve(options.root) !== options.root || options.root === '/') {
    throw failure('INVALID_ROOT', 'Storage root must be an absolute, normalized private directory');
  }
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') {
    throw failure('UNSUPPORTED_PLATFORM', 'Verified file storage currently requires Linux /proc/self/fd');
  }
  const root = options.root;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxConcurrent = options.maxConcurrent ?? 4;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 ||
      !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 128) {
    throw failure('INVALID_INPUT', 'Invalid file size or concurrency limit');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root) throw failure('INVALID_ROOT', 'Storage root may not contain symlinks');
  const rootHandle = await directory(root);
  let files: FileHandle;
  let staging: FileHandle;
  try {
    for (const child of ['files', 'staging']) {
      try { await mkdir(fdPath(rootHandle, child), { mode: 0o700 }); }
      catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
    }
    files = await directory(fdPath(rootHandle, 'files'));
    try { staging = await directory(fdPath(rootHandle, 'staging')); }
    catch (error) { await files.close(); throw error; }
  } catch (error) { await rootHandle.close(); throw error; }
  const shutdown = new AbortController();
  const inFlight = new Map<string, Promise<FileMetadata>>();
  const discards = new Set<Promise<void>>();
  const streams = new Set<Readable>();
  const filesStat = await files.stat({ bigint: true });
  const taskKey = (id: string) => `${filesStat.dev}:${filesStat.ino}:${id}`;
  let active = 0;
  let closing: Promise<void> | undefined;

  function ensureOpen() {
    if (shutdown.signal.aborted) throw failure('CLOSED', 'File storage is closed');
  }
  async function slot(id: string): Promise<FileHandle | undefined> {
    try { return await directory(fdPath(files, id)); }
    catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw asFailure(error); }
  }
  async function discarded(handle: FileHandle, id: string): Promise<Discard | undefined> {
    let value: unknown;
    try { value = await readJson(handle, 'discarded.json'); }
    catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw error; }
    if (!object(value) || value.version !== 1 || value.id !== id || !validOwner(value.owner)) {
      throw failure('CORRUPT', 'Invalid upload discard marker');
    }
    return value as Discard;
  }
  function validOwner(owner: unknown): owner is OperationOwner {
    return object(owner) && Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0
      && typeof owner.operation === 'string' && /^[a-f0-9-]{36}$/.test(owner.operation);
  }
  async function metadata(handle: FileHandle, id: string): Promise<DiskMetadata | undefined> {
    let ready: FileHandle;
    try { ready = await directory(fdPath(handle, 'ready')); }
    catch (error) { if (hasCode(error, 'ENOENT')) return undefined; throw error; }
    try {
      const value = await readJson(ready, 'metadata.json');
      if (!object(value) || value.version !== 2 || value.id !== id || typeof value.name !== 'string' ||
          typeof value.body !== 'string' || !BODY.test(value.body) || typeof value.mime !== 'string' ||
          (value.mime !== 'application/octet-stream' && !INLINE_MIMES.has(value.mime)) ||
          !Number.isSafeInteger(value.size) || (value.size as number) < 0 ||
          typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
          typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
          value.inline !== INLINE_MIMES.has(value.mime) || !validStamp(value.bodyStamp)) {
        throw failure('CORRUPT', 'Invalid stored file metadata');
      }
      const identity = parseIdentity(value.identity);
      if (identityId(identity) !== id || identity.name !== value.name) throw failure('CORRUPT', 'Stored identity mismatch');
      const body = await open(fdPath(ready, value.body), READ_FLAGS);
      try {
        await validateBody(body, { size: value.size as number, bodyStamp: value.bodyStamp });
      } finally { await body.close(); }
      return value as unknown as DiskMetadata;
    } finally { await ready.close(); }
  }
  function publicMetadata(value: DiskMetadata): FileMetadata {
    return {
      id: value.id, name: value.name, mime: value.mime, size: value.size, sha256: value.sha256,
      createdAt: value.createdAt, inline: value.inline, path: join(root, 'files', value.id, 'ready', value.body),
    };
  }
  async function lookupState(handle: FileHandle, id: string): Promise<Exclude<FileLookup, { state: 'no-record' }>> {
    const state = await readJson(handle, 'state.json');
    if (object(state) && state.state === 'failed' && object(state.error) &&
        typeof state.error.code === 'string' && typeof state.error.message === 'string') {
      return { state: 'failed', fileId: id, error: { code: state.error.code, message: state.error.message } };
    }
    if (!object(state) || state.state !== 'pending') throw failure('CORRUPT', 'Invalid stored operation state');
    const owner = state.owner;
    if (owner !== undefined && (!object(owner) || !Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1 ||
        typeof owner.operation !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.operation))) {
      throw failure('CORRUPT', 'Invalid stored operation owner');
    }
    if (object(owner) && owner.pid === process.pid && activeOperations.get(owner.operation as string) === id) {
      return { state: 'pending', fileId: id };
    }
    // An owner can finish between the first ready check and the state read.
    const saved = await metadata(handle, id);
    if (saved) return { state: 'ready', file: publicMetadata(saved) };
    const foreign = object(owner) && owner.pid !== process.pid;
    return {
      state: 'failed', fileId: id,
      error: {
        code: foreign ? 'ACTIVITY_UNKNOWN' : 'INTERRUPTED',
        message: foreign
          ? 'Operation belongs to another process; activity cannot be confirmed and no source was reopened'
          : 'Operation has no active owner and was interrupted; no source was reopened',
      },
    };
  }
  async function lookupFile(id: string): Promise<FileLookup> {
    ensureOpen();
    checkId(id);
    const handle = await slot(id);
    if (!handle) return inFlight.has(id) ? { state: 'pending', fileId: id } : { state: 'no-record' };
    try {
      if (await discarded(handle, id)) return { state: 'no-record' };
      const saved = await metadata(handle, id);
      if (saved) return { state: 'ready', file: publicMetadata(saved) };
      const identity = parseIdentity(await readJson(handle, 'identity.json'));
      if (identityId(identity) !== id) throw failure('CORRUPT', 'Stored identity mismatch');
      return await lookupState(handle, id);
    } catch (error) {
      if (await discarded(handle, id)) return { state: 'no-record' };
      throw asFailure(error);
    }
    finally { await handle.close(); }
  }
  async function reserve(identity: Identity, owner: OperationOwner): Promise<{ handle: FileHandle; created: boolean }> {
    const id = identityId(identity);
    let handle = await slot(id);
    if (handle) return { handle, created: false };
    const stageName = `reserve-${randomUUID()}`;
    const stagePath = fdPath(staging, stageName);
    await mkdir(stagePath, { mode: 0o700 });
    try {
      handle = await directory(stagePath);
      try {
        await writeJson(handle, 'identity.json', identity);
        await writeJson(handle, 'state.json', { state: 'pending', owner } satisfies State);
      } finally { await handle.close(); }
      let created = false;
      try { await rename(stagePath, fdPath(files, id)); created = true; await files.sync(); }
      catch (error) { if (!hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EEXIST')) throw error; }
      const result = await slot(id);
      if (!result) throw failure('IO_ERROR', 'Operation reservation disappeared');
      return { handle: result, created };
    } finally { await rm(stagePath, { recursive: true, force: true }); }
  }
  async function execute(identity: Identity, input: FileInput | CaptureSource, signal: AbortSignal, owner: OperationOwner): Promise<FileMetadata> {
    const id = identityId(identity);
    const { handle, created } = await reserve(identity, owner);
    let attempt: FileHandle | undefined;
    let attemptOwned = false;
    let committed = false;
    try {
      if (await discarded(handle, id)) throw failure('DISCARDED', 'Upload operation was permanently discarded');
      const previousIdentity = parseIdentity(await readJson(handle, 'identity.json'));
      if (identityId(previousIdentity) !== id || (identity.kind === 'upload' && previousIdentity.name !== identity.name)) {
        throw failure('CONFLICT', 'The operation identity was already used for a different file');
      }
      const saved = identity.kind === 'capture' ? await metadata(handle, id) : undefined;
      if (saved) {
        committed = true;
        return publicMetadata(saved);
      }
      const state = await readJson(handle, 'state.json');
      if (!object(state) || (state.state !== 'pending' && state.state !== 'failed')) throw failure('CORRUPT', 'Invalid operation state');
      if (state.state === 'failed' && identity.kind === 'capture') {
        if (!object(state.error) || typeof state.error.code !== 'string' || typeof state.error.message !== 'string') {
          throw failure('CORRUPT', 'Invalid capture failure');
        }
        throw failure(state.error.code, state.error.message);
      }
      if (!created && identity.kind === 'capture') {
        const existing = await lookupState(handle, id);
        if (existing.state === 'ready') { committed = true; return existing.file; }
        throw failure(existing.state === 'pending' ? 'PENDING' : existing.error.code,
          existing.state === 'pending' ? 'Capture is already in progress; the source will not be reopened' : existing.error.message);
      }
      try { await mkdir(fdPath(handle, 'attempt'), { mode: 0o700 }); attemptOwned = true; }
      catch (error) {
        if (hasCode(error, 'EEXIST')) {
          const existing = await lookupState(handle, id);
          throw failure(existing.state === 'failed' ? existing.error.code : 'PENDING',
            existing.state === 'failed' ? existing.error.message : 'Operation is already in progress; retry the same identity');
        }
        throw error;
      }
      attempt = await directory(fdPath(handle, 'attempt'));
      if (await discarded(handle, id)) throw failure('DISCARDED', 'Upload operation was permanently discarded');
      const concurrentlyCommitted = await metadata(handle, id);
      if (concurrentlyCommitted) {
        committed = true;
        const verified = await consume(input as FileInput, maxBytes, signal);
        if (verified.size !== concurrentlyCommitted.size || verified.sha256 !== concurrentlyCommitted.sha256 ||
            verified.mime !== concurrentlyCommitted.mime) {
          throw new FileStorageError('CONFLICT', 'Upload retry bytes differ from the committed original', { fileId: id, committed: true });
        }
        return publicMetadata(concurrentlyCommitted);
      }
      await writeJson(handle, 'state.json', { state: 'pending', owner } satisfies State);
      aborted(signal);
      let source: FileHandle | undefined;
      await mkdir(fdPath(attempt, 'payload'), { mode: 0o700 });
      const payload = await directory(fdPath(attempt, 'payload'));
      try {
        let initial: BigIntStats | undefined;
        let sourceInput: FileInput;
        if ('paths' in input) {
          for (const path of input.paths) {
            let candidate: FileHandle;
            try { candidate = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); }
            catch (error) {
              if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) continue;
              throw failure('SOURCE_UNREADABLE', 'Cannot inspect capture source candidates', error);
            }
            let selected = false;
            try {
              const info = await candidate.stat({ bigint: true });
              if (!info.isFile()) throw failure('INVALID_SOURCE', 'Capture source must be a regular file');
              if (source) throw failure('AMBIGUOUS_SOURCE', 'Relative reference exists in both the project and session workspace');
              source = candidate;
              initial = info;
              selected = true;
            } finally { if (!selected) await candidate.close(); }
          }
          if (!source || !initial) throw failure('SOURCE_NOT_FOUND', 'Cannot open capture source');
          if (initial.size > BigInt(maxBytes)) throw failure('LIMIT_EXCEEDED', `File exceeds the ${maxBytes}-byte limit`);
          sourceInput = sourceBytes(source);
        } else sourceInput = input;
        const output = await open(fdPath(payload, 'body'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        let details: Awaited<ReturnType<typeof consume>>;
        let body: string;
        let stamp: BodyStamp;
        try {
          details = await consume(sourceInput, maxBytes, signal, output);
          if (source && initial) {
            const final = await source.stat({ bigint: true });
            if (initial.dev !== final.dev || initial.ino !== final.ino || initial.size !== final.size ||
                initial.mtimeNs !== final.mtimeNs || initial.ctimeNs !== final.ctimeNs || BigInt(details.size) !== final.size) {
              throw failure('SOURCE_CHANGED', 'Capture source changed while copying; no snapshot was published');
            }
          }
          await output.sync();
          body = bodyName(identity.name, details.mime);
          if (body !== 'body') await rename(fdPath(payload, 'body'), fdPath(payload, body));
          stamp = bodyStamp(await output.stat({ bigint: true }));
          if (stamp.size !== String(details.size)) throw failure('CORRUPT', 'Original size changed before publication');
        } finally { await output.close(); }
        const saved: DiskMetadata = {
          version: 2, id, name: identity.name, ...details, createdAt: new Date().toISOString(),
          inline: INLINE_MIMES.has(details.mime), body, bodyStamp: stamp, identity,
        };
        await writeJson(payload, 'metadata.json', saved);
        await payload.sync();
        const checked = await open(fdPath(payload, body), READ_FLAGS);
        try { await validateBody(checked, saved); }
        finally { await checked.close(); }
        aborted(signal);
        await rename(fdPath(attempt, 'payload'), fdPath(handle, 'ready'));
        committed = true;
        try { await handle.sync(); }
        catch (error) {
          throw new FileStorageError('COMMIT_UNCERTAIN', 'Original published, but durability confirmation failed; query the same identity', {
            cause: error, fileId: id, committed: true,
          });
        }
        return publicMetadata(saved);
      } finally {
        await payload.close();
        if (source) await source.close();
      }
    } catch (error) {
      const reason = asFailure(error);
      if (committed && !reason.committed) {
        throw new FileStorageError(reason.code === 'IO_ERROR' ? 'POST_COMMIT_FAILED' : reason.code,
          reason.code === 'IO_ERROR' ? 'Original was published, but finalization failed; query the same identity' : reason.message, {
          cause: reason, fileId: id, committed: true,
        });
      }
      if (attemptOwned && !committed && !await discarded(handle, id)) {
        try { await writeJson(handle, 'state.json', { state: 'failed', error: { code: reason.code, message: reason.message } } satisfies State); }
        catch (recordError) {
          throw new FileStorageError('STATE_UNCERTAIN', 'Operation failed and its failure record could not be persisted', {
            cause: new AggregateError([reason, recordError]), fileId: id,
          });
        }
      }
      throw reason;
    } finally {
      try {
        if (attempt) await attempt.close();
        if (attemptOwned) await removeTree(handle, 'attempt');
      } catch (error) {
        throw new FileStorageError('CLEANUP_FAILED', 'Could not clean this operation staging directory; query the same identity', {
          cause: error, fileId: id, committed,
        });
      } finally { await handle.close(); }
    }
  }
  function schedule(identity: Identity, input: FileInput | CaptureSource, signal?: AbortSignal): Promise<FileMetadata> {
    ensureOpen();
    if (Buffer.byteLength(JSON.stringify(identity)) > 60 * 1024) {
      throw failure('INVALID_INPUT', 'Operation identity exceeds its metadata byte limit');
    }
    const id = identityId(identity);
    const existing = inFlight.get(id);
    if (existing && identity.kind === 'capture') return existing;
    const local = identity.kind === 'upload' ? uploadTasks.get(taskKey(id)) : undefined;
    if (local) return Promise.reject(failure(local.kind === 'discard' ? 'DISCARDED' : 'PENDING',
      local.kind === 'discard' ? 'Upload discard is in progress' : 'Upload operation is already in progress'));
    const controller = new AbortController();
    const combined = AbortSignal.any([...(signal ? [signal] : []), shutdown.signal, controller.signal]);
    if (existing) return Promise.reject(failure('PENDING', 'Upload operation is already in progress; query or retry the same identity'));
    if (active >= maxConcurrent) return Promise.reject(failure('BUSY', 'File storage concurrency limit reached'));
    active++;
    const owner = { pid: process.pid, operation: randomUUID() };
    activeOperations.set(owner.operation, id);
    const promise = execute(identity, input, combined, owner).finally(async () => {
      try {
        if (input instanceof Readable) input.destroy();
        else if ('cancel' in input && !input.locked) {
          let onAbort = () => {};
          const cancellation = new Promise<void>(resolve => { onAbort = resolve; });
          combined.addEventListener('abort', onAbort, { once: true });
          if (combined.aborted) onAbort();
          try { await Promise.race([input.cancel(), cancellation]); }
          finally { combined.removeEventListener('abort', onAbort); }
        }
      } finally {
        active--;
        activeOperations.delete(owner.operation);
        if (uploadTasks.get(taskKey(id))?.promise === promise) uploadTasks.delete(taskKey(id));
        if (inFlight.get(id) === promise) inFlight.delete(id);
      }
    });
    inFlight.set(id, promise);
    if (identity.kind === 'upload') uploadTasks.set(taskKey(id), { kind: 'upload', controller, promise });
    return promise;
  }
  async function discard(identity: Identity, owner: OperationOwner): Promise<void> {
    const id = identityId(identity);
    const { handle } = await reserve(identity, owner);
    let attemptOwned = false;
    try {
      const previousIdentity = parseIdentity(await readJson(handle, 'identity.json'));
      if (previousIdentity.kind !== 'upload' || identityId(previousIdentity) !== id) {
        throw failure('CORRUPT', 'Stored upload identity mismatch');
      }
      try { await mkdir(fdPath(handle, 'attempt'), { mode: 0o700 }); attemptOwned = true; }
      catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
        // State can predate a foreign owner's mkdir, so it cannot authorize lock reclamation.
        throw failure('ACTIVITY_UNKNOWN', 'Another process may own this operation staging; discard was not performed');
      }
      let state: unknown;
      try { state = await readJson(handle, 'state.json'); }
      catch (error) { if (!hasCode(error, 'ENOENT') || !await discarded(handle, id)) throw error; }
      if (object(state) && state.state === 'pending'
          && (!validOwner(state.owner) || state.owner.pid !== process.pid)
          && !await discarded(handle, id) && !await metadata(handle, id)) {
        throw failure('ACTIVITY_UNKNOWN', 'Pending upload ownership cannot be confirmed; discard was not performed');
      }
      await writeJson(handle, 'discarded.json', { version: 1, id, owner } satisfies Discard);
      await removeTree(handle, 'ready');
      await rm(fdPath(handle, 'state.json'), { force: true });
      await handle.sync();
    } catch (error) { throw asFailure(error); }
    finally {
      try {
        if (attemptOwned) { await removeTree(handle, 'attempt'); await handle.sync(); }
      } catch (error) {
        throw new FileStorageError('CLEANUP_FAILED', 'Upload discard cleanup failed; retry the same operation identity', {
          cause: error, fileId: id,
        });
      } finally { await handle.close(); }
    }
  }
  function discardUpload(operationId: string): Promise<void> {
    ensureOpen();
    const identity: Identity = { kind: 'upload', operationId: uploadKey(operationId), name: '' };
    const id = identityId(identity);
    const token = taskKey(id);
    const previous = uploadTasks.get(token);
    if (previous?.kind !== 'discard' && discards.size >= maxConcurrent) {
      return Promise.reject(failure('BUSY', 'Upload discard concurrency limit reached'));
    }
    const owner = { pid: process.pid, operation: randomUUID() };
    const controller = new AbortController();
    if (previous?.kind === 'upload') previous.controller.abort();
    const promise = previous?.kind === 'discard' ? previous.promise as Promise<void> : (async () => {
      // Do not share the upload worker queue: a stalled upload must be cancelled first.
      if (previous) await Promise.allSettled([previous.promise]);
      try { await discard(identity, owner); }
      catch (error) { throw asFailure(error); }
    })().finally(() => {
      activeOperations.delete(owner.operation);
      if (uploadTasks.get(token)?.promise === promise) uploadTasks.delete(token);
    });
    if (previous?.kind !== 'discard') {
      activeOperations.set(owner.operation, id);
      uploadTasks.set(token, { kind: 'discard', controller, promise });
    }
    discards.add(promise);
    void promise.then(() => discards.delete(promise), () => discards.delete(promise));
    return promise;
  }
  return {
    root, maxBytes,
    upload(operationId, stream, name, _mime, signal) {
      return schedule({ kind: 'upload', operationId: uploadKey(operationId), name: nameOf(name) }, stream, signal);
    },
    discardUpload,
    capture(messageKey, reference, sourcePath, signal) {
      const paths = [...new Set(typeof sourcePath === 'string' ? [sourcePath] : sourcePath)];
      if (!paths.length || paths.length > 2) throw failure('INVALID_INPUT', 'Capture requires one or two explicit source candidates');
      for (const path of paths) {
        key(path, 'sourcePath');
        if (!isAbsolute(path)) throw failure('INVALID_INPUT', 'Capture source must be an explicitly resolved absolute path');
      }
      return schedule({
        kind: 'capture', messageKey: key(messageKey, 'messageKey'), reference: key(reference, 'reference'), name: nameOf(basename(paths[0]!)),
      }, { paths }, signal);
    },
    lookupFile,
    lookupUpload(operationId) {
      return lookupFile(identityId({ kind: 'upload', operationId: uploadKey(operationId), name: '' }));
    },
    lookupCapture(messageKey, reference) {
      return lookupFile(identityId({ kind: 'capture', messageKey: key(messageKey, 'messageKey'), reference: key(reference, 'reference'), name: '' }));
    },
    async openFile(id, range) {
      ensureOpen();
      checkId(id);
      const handle = await slot(id);
      if (!handle) throw failure(inFlight.has(id) ? 'PENDING' : 'NOT_FOUND', 'No ready managed file record');
      let body: FileHandle | undefined;
      try {
        if (await discarded(handle, id)) throw failure('NOT_FOUND', 'Upload operation was discarded');
        let saved = await metadata(handle, id);
        if (!saved) {
          const state = await lookupState(handle, id);
          if (state.state !== 'ready') {
            const code = state.state === 'pending' ? 'PENDING'
              : ['INTERRUPTED', 'ACTIVITY_UNKNOWN'].includes(state.error.code) ? state.error.code : 'CAPTURE_FAILED';
            throw failure(code,
              state.state === 'pending' ? 'No ready original' : state.error.message);
          }
          saved = await metadata(handle, id);
          if (!saved) throw failure('CORRUPT', 'Published original disappeared');
        }
        const ready = await directory(fdPath(handle, 'ready'));
        try { body = await open(fdPath(ready, saved.body), READ_FLAGS); }
        finally { await ready.close(); }
        await validateBody(body, saved);
        ensureOpen();
        const start = range?.start ?? 0;
        const end = range?.end ?? saved.size - 1;
        if (range && (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            start < 0 || end < start || end >= saved.size)) throw failure('INVALID_RANGE', 'Range is outside the original');
        let stream: Readable;
        if (saved.size === 0) { await body.close(); body = undefined; stream = Readable.from([]); }
        else { stream = body.createReadStream({ start, end, autoClose: true, highWaterMark: BLOCK_BYTES }); body = undefined; }
        streams.add(stream);
        stream.once('close', () => streams.delete(stream));
        return { file: publicMetadata(saved), stream, start, end, length: saved.size === 0 ? 0 : end - start + 1 };
      } catch (error) {
        if (await discarded(handle, id)) throw failure('NOT_FOUND', 'Upload operation was discarded');
        throw asFailure(error);
      }
      finally { if (body) await body.close(); await handle.close(); }
    },
    close() {
      if (!closing) {
        shutdown.abort(failure('CLOSED', 'File storage closed'));
        for (const stream of streams) stream.destroy();
        closing = (async () => {
          await Promise.allSettled([...inFlight.values(), ...discards]);
          await staging.close();
          await files.close();
          await rootHandle.close();
        })();
      }
      return closing;
    },
  };
}
