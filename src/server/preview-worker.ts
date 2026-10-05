import { parentPort, workerData } from 'node:worker_threads';
import { renderDocument } from './document-renderer.ts';
import { FileStorageError } from './storage.ts';
import { MAX_RENDERED_BYTES } from '../shared/documents.ts';

if (!parentPort) throw new Error('Document renderer requires a worker thread');
try {
  const html = renderDocument(workerData.content, workerData.kind, workerData.name, workerData.host);
  if (Buffer.byteLength(html) > MAX_RENDERED_BYTES) throw new FileStorageError('LIMIT_EXCEEDED', 'Rendered document exceeds 16 MiB; download the original.');
  parentPort.postMessage({ html });
} catch (error) {
  if (error instanceof FileStorageError) parentPort.postMessage({ code: error.code, error: error.message });
  else if (error instanceof RangeError) parentPort.postMessage({ code: 'LIMIT_EXCEEDED', error: 'Document is too complex to render; download the original.' });
  else throw error;
}
