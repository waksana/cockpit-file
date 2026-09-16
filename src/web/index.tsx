import type {
  ActivateFrontend, ComposerContext, ModuleDraft, ModuleFrontend, RenderNode,
} from '@cockpit/module-api';
import { isLocalFileReference, messageFileUrl, nativeFileUrl } from '../shared/files.ts';
import { DEFAULT_MAX_BYTES, FileProbes, formatBytes, previewKind, UploadStore } from './file-state.ts';

export const activate: ActivateFrontend = context => {
  const React = context.react;
  const nativePathPrefix = typeof context.config.nativePathPrefix === 'string' ? context.config.nativePathPrefix : '';
  const maxBytes = typeof context.config.maxBytes === 'number' && Number.isSafeInteger(context.config.maxBytes) && context.config.maxBytes > 0
    ? context.config.maxBytes : DEFAULT_MAX_BYTES;
  let storage: Storage | undefined;
  try {
    storage = typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch (error) {
    context.report(error);
  }
  const uploads = new UploadStore({
    request: context.request, report: context.report, apiBase: context.apiBase, nativePathPrefix, maxBytes, storage,
  });
  const probes = new FileProbes(context.request, context.apiBase);
  const page = typeof document === 'undefined' ? undefined : document;
  const visibilityChanged = () => probes.setVisible(page?.visibilityState !== 'hidden');
  visibilityChanged();
  page?.addEventListener('visibilitychange', visibilityChanged);

  function useDraft(draft: ModuleDraft) {
    return React.useSyncExternalStore(
      React.useCallback(listener => draft.subscribe(listener), [draft]),
      React.useCallback(() => draft.getSnapshot(), [draft]),
    );
  }

  function useUploads(draft: ModuleDraft) {
    return React.useSyncExternalStore(
      React.useCallback(listener => uploads.subscribe(draft, listener), [draft]),
      React.useCallback(() => uploads.snapshot(draft), [draft]),
    );
  }

  function UploadAction(composer: ComposerContext) {
    const input = React.useRef<HTMLInputElement>(null);
    const selectionContext = React.useRef<ComposerContext | null>(null);
    const disabled = composer.disabled || composer.operation !== 'prompt' || !nativePathPrefix || context.signal.aborted;
    return <span className="cf-upload-action">
      <button
        type="button"
        className="cf-button cf-upload-button"
        disabled={disabled}
        title={composer.operation === 'prompt' ? `添加文件（单个最多 ${formatBytes(maxBytes)}）` : '当前操作不接受附件'}
        aria-label="添加文件"
        onClick={() => {
          selectionContext.current = composer;
          input.current?.click();
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <path d="m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9a7 7 0 0 1 10 10l-9 9" />
        </svg>
        <span>附件</span>
      </button>
      <input
        ref={input} type="file" multiple className="cf-file-input" tabIndex={-1} aria-label="选择文件"
        disabled={disabled}
        onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          const bound = selectionContext.current;
          selectionContext.current = null;
          if (bound) uploads.receive(files, bound);
        }}
      />
    </span>;
  }

  function AttachmentList(composer: ComposerContext) {
    const draft = useDraft(composer.draft);
    const pending = useUploads(composer.draft);
    const ready = draft.attachments;
    if (!ready.length && !pending.items.length && !pending.error) return null;
    return <section className="cf-attachments" aria-label="文件附件">
      {pending.error && <p className="cf-error" role="alert">{pending.error}</p>}
      {(ready.length > 0 || pending.items.length > 0) && <ul className="cf-attachment-list">
        {ready.map(item => <li className="cf-attachment" key={item.id}>
          <span className="cf-attachment-details">
            <span className="cf-filename">{item.value.displayName || '附件'}</span>
            <span className="cf-status">准备就绪</span>
          </span>
          <button type="button" className="cf-button" onClick={() => {
            try {
              composer.draft.removeAttachment(item.id);
            } catch (error) {
              context.report(error);
            }
          }}
            aria-label={`移除 ${item.value.displayName || '附件'}`}>移除</button>
        </li>)}
        {pending.items.map(item => <li className="cf-attachment" key={item.id} aria-busy={item.status === 'uploading'}>
          <span className="cf-attachment-details">
            <span className="cf-filename">{item.name}</span>
            <span className={`cf-status${item.error ? ' cf-error' : ''}`} role={item.error ? 'alert' : 'status'}>
              {item.status === 'uploading' ? `上传中 · ${formatBytes(item.size)}`
                : item.status === 'ready' ? '已上传，等待前面的文件'
                  : item.error}
            </span>
          </span>
          {item.status === 'failed' && <button type="button" className="cf-button"
            disabled={composer.disabled || composer.operation !== 'prompt'}
            onClick={() => uploads.retry(composer.draft, item.id)}
            aria-label={`重新上传 ${item.name}`}>重试</button>}
          <button type="button" className="cf-button" onClick={() => uploads.remove(composer.draft, item.id)}
            aria-label={`移除 ${item.name}`}>移除</button>
        </li>)}
      </ul>}
      {pending.items.length > 0 && <p className="cf-status">请等待上传完成，或移除未完成的文件后发送。</p>}
      {ready.length > 0 && composer.operation !== 'prompt' &&
        <p className="cf-error" role="alert">当前操作不接受附件，请先移除附件或稍后通过普通消息发送。</p>}
    </section>;
  }

  function nodeUrl(node: RenderNode): string | null {
    if (node.kind === 'attachment') {
      return node.attachment?.type === 'file'
        ? nativeFileUrl(node.attachment.path, nativePathPrefix, context.apiBase) : null;
    }
    if (!node.target || !isLocalFileReference(node.target)) return null;
    try {
      return messageFileUrl(context.apiBase, node.origin, node.target);
    } catch {
      return null;
    }
  }

  function FileCard({ url, name }: { url: string; name: string }) {
    const state = React.useSyncExternalStore(
      React.useCallback(listener => probes.subscribe(url, listener), [url]),
      React.useCallback(() => probes.snapshot(url), [url]),
    );
    const kind = state.mime ? previewKind(state.mime) : null;
    const loading = state.status === 'pending' || state.preview === 'pending';
    const mediaReady = () => probes.mediaReady(url, state.round);
    const mediaFailed = () => probes.mediaFailed(url, state.round);
    const mediaKey = `${url}:${state.round}`;
    return <span className="cf-card" role="group" aria-label={name} aria-busy={loading}>
      <span className="cf-card-name">{name}</span>
      {(state.status === 'pending' || kind !== null) && <span className={`cf-preview${kind === 'audio' ? ' cf-preview-audio' : ''}`}>
        {loading && <span className="cf-placeholder" role="status">文件加载中…</span>}
        {state.status === 'ready' && state.preview !== 'failed' && kind === 'image' &&
          <img key={mediaKey} className="cf-media" data-loading={state.preview === 'pending'} src={url} alt={name}
            onLoad={mediaReady} onError={mediaFailed} />}
        {state.status === 'ready' && state.preview !== 'failed' && kind === 'video' &&
          <video key={mediaKey} className="cf-media" data-loading={state.preview === 'pending'} src={url} controls preload="metadata"
            aria-label={name} onLoadedMetadata={mediaReady} onError={mediaFailed} />}
        {state.status === 'ready' && state.preview !== 'failed' && kind === 'audio' &&
          <audio key={mediaKey} className="cf-media" data-loading={state.preview === 'pending'} src={url} controls preload="metadata"
            aria-label={name} onLoadedMetadata={mediaReady} onError={mediaFailed} />}
        {state.preview === 'failed' && <span className="cf-placeholder">无法预览</span>}
      </span>}
      {state.error && <span className="cf-error" role="status">{state.error}</span>}
      <span className="cf-card-footer">
        {state.status === 'ready' && <>
          <span className="cf-status">{state.size !== undefined ? formatBytes(state.size) : state.mime}</span>
          <a className="cf-download" href={`${url}?download=1`} download={name}>下载</a>
        </>}
        {(state.status === 'unavailable' || state.preview === 'failed') &&
          <button type="button" className="cf-button" onClick={() => probes.retry(url)}>重试</button>}
      </span>
    </span>;
  }

  function FileRenderer({ node }: { node: RenderNode }) {
    const url = nodeUrl(node);
    if (!url) return <span>{node.label}</span>;
    return <FileCard key={url} url={url} name={node.label || node.attachment?.displayName || '文件'} />;
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    context.signal.removeEventListener('abort', dispose);
    page?.removeEventListener('visibilitychange', visibilityChanged);
    uploads.dispose();
    probes.dispose();
  }
  context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose();
  const frontend: ModuleFrontend = {
    writes: ['attachments'],
    composerActions: [{ id: 'upload', component: UploadAction }],
    composerAbove: [{ id: 'attachments', component: AttachmentList }],
    fileInput: [{
      id: 'upload',
      accepts: files => !disposed && !!nativePathPrefix && files.length > 0,
      receive: (files, composer) => uploads.receive(files, composer),
    }],
    chatRenderers: [{
      id: 'files',
      matches: node => !disposed && nodeUrl(node) !== null,
      component: FileRenderer,
    }],
    dispose,
  };
  return frontend;
};
