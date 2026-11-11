import { Worker } from 'node:worker_threads';
import { FileStorageError } from './storage.ts';
import { MAX_PREVIEW_BYTES, type DocumentKind } from '../shared/documents.ts';

export async function readDocument(stream: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    signal.throwIfAborted();
    size += chunk.byteLength;
    if (size > MAX_PREVIEW_BYTES) throw new FileStorageError('LIMIT_EXCEEDED', 'Document preview is limited to 2 MiB; download the original.');
    chunks.push(chunk);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (text.includes('\0')) throw new Error('Binary document');
    return text;
  } catch (cause) {
    throw new FileStorageError('INVALID_SOURCE', 'Preview requires UTF-8 text without NUL bytes; download the original.', { cause });
  }
}

export async function renderIsolated(content: string, kind: DocumentKind, name: string, host: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './preview-worker.ts' : './preview-worker.cjs', import.meta.url), {
    workerData: { content, kind, name, host },
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      abort = () => reject(new FileStorageError('ABORTED', 'Document preview was cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new FileStorageError('LIMIT_EXCEEDED', 'Document rendering exceeded three seconds; download the original.')), 3_000);
      worker.once('error', error => reject(new FileStorageError(
        error instanceof Error && 'code' in error && error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'LIMIT_EXCEEDED' : 'PREVIEW_FAILED',
        'Document renderer failed or exceeded its memory limit; download the original.', { cause: error },
      )));
      worker.once('exit', () => reject(new FileStorageError('PREVIEW_FAILED', 'Document renderer exited without a result.')));
      worker.once('message', (value: unknown) => {
        if (value && typeof value === 'object' && 'html' in value && typeof value.html === 'string') resolve(value.html);
        else if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' &&
            'code' in value && (value.code === 'LIMIT_EXCEEDED' || value.code === 'INVALID_SOURCE')) {
          reject(new FileStorageError(value.code, value.error));
        } else reject(new FileStorageError('PREVIEW_FAILED', 'Document renderer returned an invalid result.'));
      });
      if (signal.aborted) abort();
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    await worker.terminate();
  }
}
