import type { UploadStore } from './file-state.ts';

export interface UnloadTarget {
  addEventListener(type: 'beforeunload', listener: (event: BeforeUnloadEvent) => void): void;
  removeEventListener(type: 'beforeunload', listener: (event: BeforeUnloadEvent) => void): void;
}

export function protectUnpersistedFiles(
  target: UnloadTarget | undefined, uploads: Pick<UploadStore, 'hasUnpersistedWork'>,
): () => void {
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!uploads.hasUnpersistedWork()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  target?.addEventListener('beforeunload', beforeUnload);
  return () => target?.removeEventListener('beforeunload', beforeUnload);
}
