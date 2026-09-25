import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';
import { registerFileDrafts } from './file-draft.ts';
import { FileInputs } from './file-input.ts';
import { DEFAULT_MAX_BYTES, FileProbes, UploadStore } from './file-state.ts';
import { protectUnpersistedFiles } from './unload.ts';

export function createFileServices(context: ModuleFrontendContext) {
  const nativePathPrefix = typeof context.config.nativePathPrefix === 'string' ? context.config.nativePathPrefix : '';
  const maxBytes = typeof context.config.maxBytes === 'number' && Number.isSafeInteger(context.config.maxBytes) && context.config.maxBytes > 0
    ? context.config.maxBytes : DEFAULT_MAX_BYTES;
  const fileDrafts = registerFileDrafts(context.state);
  const resources = context.state.register({
    id: 'view-resources',
    create: () => new Set<() => void>(),
    dispose: releases => { for (const release of [...releases]) release(); releases.clear(); },
  }).get();
  const uploads = context.state.register({
    id: 'uploads',
    create: () => new UploadStore({
      request: context.request, report: context.report, apiBase: context.apiBase, nativePathPrefix, maxBytes,
    }),
    dispose: store => store.dispose(),
  }).get();
  const probes = context.state.register({
    id: 'file-probes',
    create: () => new FileProbes(context.request, context.apiBase),
    dispose: store => store.dispose(),
  }).get();
  const page = typeof document === 'undefined' ? undefined : document;
  const inputs = context.state.register({
    id: 'file-inputs',
    create: () => new FileInputs({
      uploads, report: context.report, signal: context.signal, page, enabled: !!nativePathPrefix,
    }),
    dispose: store => store.dispose(),
  }).get();
  const visibilityChanged = () => probes.setVisible(context.state.host.getSnapshot().visible);
  visibilityChanged();
  resources.add(context.state.host.subscribe(visibilityChanged));
  const releaseUnload = protectUnpersistedFiles(page?.defaultView ?? undefined, uploads);
  resources.add(releaseUnload);
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    releaseUnload();
    resources.delete(releaseUnload);
    inputs.dispose();
    context.signal.removeEventListener('abort', dispose);
  }
  context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose();
  return {
    nativePathPrefix, maxBytes, fileDrafts, resources, uploads, probes, inputs, page, dispose,
    get disposed() { return disposed; },
  };
}

export type FileServices = ReturnType<typeof createFileServices>;
