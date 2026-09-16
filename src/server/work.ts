import { FileStorageError } from './storage.ts';

export function createWorkLimit(concurrency: number, pendingLimit: number, signal: AbortSignal) {
  const queue: { start(): void; reject(error: Error): void }[] = [];
  let active = 0;
  let stopped = false;
  const closed = () => new FileStorageError('CLOSED', 'File module is closing');
  const drain = () => {
    while (active < concurrency && queue.length && !signal.aborted && !stopped) queue.shift()!.start();
  };
  const stop = () => { stopped = true; for (const item of queue.splice(0)) item.reject(closed()); };
  signal.addEventListener('abort', stop, { once: true });
  return {
    run<T>(operation: () => Promise<T>, requestSignal?: AbortSignal): Promise<T> {
      if (stopped || signal.aborted || requestSignal?.aborted) return Promise.reject(closed());
      if (active >= concurrency && queue.length >= pendingLimit) {
        return Promise.reject(new FileStorageError('BUSY', 'File operation queue is full'));
      }
      return new Promise<T>((resolve, reject) => {
        const abort = () => {
          const index = queue.indexOf(item);
          if (index >= 0) queue.splice(index, 1);
          reject(new FileStorageError('ABORTED', 'Queued file operation was cancelled'));
        };
        const item = {
          reject(error: Error) { requestSignal?.removeEventListener('abort', abort); reject(error); },
          start() {
            requestSignal?.removeEventListener('abort', abort);
            if (stopped || signal.aborted || requestSignal?.aborted) { reject(closed()); return; }
            active++;
            void Promise.resolve().then(operation).then(resolve, reject).finally(() => { active--; drain(); });
          },
        };
        if (active < concurrency) item.start();
        else {
          queue.push(item);
          requestSignal?.addEventListener('abort', abort, { once: true });
        }
      });
    },
    dispose() { signal.removeEventListener('abort', stop); stop(); },
  };
}
