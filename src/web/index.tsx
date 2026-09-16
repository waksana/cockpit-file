import type {
  ActivateFrontend, ComposerContext, ModuleDraft, ModuleFrontend, RenderNode,
} from '@cockpit/module-api';
import type { ReactNode } from 'react';
import { isLocalFileReference, messageFileUrl, nativeFileUrl } from '../shared/files.ts';
import { DEFAULT_MAX_BYTES, FileProbes, formatBytes, previewKind, UploadStore } from './file-state.ts';
import { decodeNativeBlob, unavailableBlobReason, type NativeBlob } from './blob.ts';

export const activate: ActivateFrontend = context => {
  const React = context.react;
  const nativePathPrefix = typeof context.config.nativePathPrefix === 'string' ? context.config.nativePathPrefix : '';
  const maxBytes = typeof context.config.maxBytes === 'number' && Number.isSafeInteger(context.config.maxBytes) && context.config.maxBytes > 0
    ? context.config.maxBytes : DEFAULT_MAX_BYTES;
  const uploads = new UploadStore({
    request: context.request, report: context.report, apiBase: context.apiBase, nativePathPrefix, maxBytes,
  });
  const blobReleases = new Set<() => void>();
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

  function ActionIcon({ name }: { name: 'remove' | 'download' | 'retry' }) {
    return <svg className="cf-action-icon" width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={name === 'remove' ? 'm7 7 10 10M17 7 7 17'
        : name === 'download' ? 'M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4'
          : 'M19 8a8 8 0 1 0 1 8M20 3v6h-6'} />
    </svg>;
  }

  function UploadAction(composer: ComposerContext) {
    const input = React.useRef<HTMLInputElement>(null);
    const selectionContext = React.useRef<ComposerContext | null>(null);
    const draft = useDraft(composer.draft);
    const disabled = composer.disabled || draft.pending || composer.operation !== 'prompt' || !nativePathPrefix || context.signal.aborted;
    return <span className="cf-upload-action">
      <button
        type="button"
        className="cf-upload-button"
        disabled={disabled}
        title={composer.operation === 'prompt' ? `添加文件（单个最多 ${formatBytes(maxBytes)}）` : '当前操作不接受附件'}
        aria-label="添加文件"
        onClick={() => {
          selectionContext.current = composer;
          input.current?.click();
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="m9 13 6-6a2.5 2.5 0 0 1 3.5 3.5l-8 8a4.5 4.5 0 0 1-6.4-6.4l8-8" />
        </svg>
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
    const disabled = composer.disabled || draft.pending;
    const ready = draft.attachments;
    if (!ready.length && !pending.items.length && !pending.error) return null;
    return <section className="cf-attachments" aria-label="文件附件">
      {pending.error && <p className="cf-error" role="alert">{pending.error}</p>}
      {(ready.length > 0 || pending.items.length > 0) && <ul className="cf-attachment-list">
        {ready.map(item => {
          const name = item.value.displayName || '附件';
          const actions = <button type="button" className="cf-icon-button" disabled={disabled} title="移除"
            onClick={() => uploads.removeAttachment(composer.draft, item.id)} aria-label={`移除 ${name}`}><ActionIcon name="remove" /></button>;
          const status = draft.pending ? '正在提交' : '准备就绪';
          const url = item.value.type === 'file' ? nativeFileUrl(item.value.path, nativePathPrefix, context.apiBase) : null;
          return <li className="cf-attachment" key={item.id}>
            {url ? <FileCard url={url} name={name} actions={actions} status={status} download={false} />
              : item.value.type === 'blob'
                ? <BlobCard attachment={item.value} name={name} actions={actions} status={status} download={false} />
                : <FileTile name={name} status={status} actions={actions} />}
          </li>;
        })}
        {pending.items.map(item => {
          const retry = item.status === 'failed' ? <button type="button" className="cf-icon-button" title="重试上传"
            disabled={disabled || composer.operation !== 'prompt'}
            onClick={() => uploads.retry(composer.draft, item.id)} aria-label={`重新上传 ${item.name}`}><ActionIcon name="retry" /></button> : undefined;
          const actions = <button type="button" className="cf-icon-button" disabled={disabled} title="移除"
            onClick={() => uploads.remove(composer.draft, item.id)} aria-label={`移除 ${item.name}`}><ActionIcon name="remove" /></button>;
          const props = {
            name: item.name, actions, retry, download: false, error: item.error,
            busy: item.status === 'uploading',
            status: item.status === 'uploading' ? '上传中' : item.status === 'ready' ? '已上传，等待加入草稿' : '上传未完成',
          };
          return <li className="cf-attachment" key={item.id}>
            {item.url ? <FileCard {...props} url={item.url} />
              : item.file && previewKind(item.file.type) === 'image'
                ? <BlobCard {...props} file={item.file} />
                : <FileTile {...props} actions={<>{retry}{actions}</>} metadata={formatBytes(item.size)} />}
          </li>;
        })}
      </ul>}
    </section>;
  }

  interface CardProps {
    name: string;
    actions?: ReactNode;
    retry?: ReactNode;
    status?: string;
    error?: string;
    busy?: boolean;
    download?: boolean;
  }

  interface Preview {
    url: string;
    key: string;
    kind: 'image' | 'video' | 'audio';
    loading: boolean;
    ready: () => void;
    failed: () => void;
  }

  function FileTile({ name, status, error, busy = false, metadata, actions, preview }: CardProps & {
    metadata?: string; preview?: Preview;
  }) {
    const [expanded, setExpanded] = React.useState<string>();
    const dialog = React.useRef<HTMLDialogElement>(null);
    const detailsKey = `details:${name}`;
    const detailsOpen = expanded === detailsKey;
    const open = detailsOpen || (preview !== undefined && expanded === preview.key);
    const suffix = /(?:\.tar\.(?:gz|bz2|xz|zst)|\.[a-z0-9]{1,10})$/i.exec(name);
    const extension = suffix && suffix.index > 0 ? suffix[0] : '';
    const stem = extension ? name.slice(0, -extension.length) : name;
    const information = [status, metadata].filter(Boolean).join(' · ');
    React.useEffect(() => {
      if (!open) return;
      const element = dialog.current;
      element?.showModal();
      return () => element?.close();
    }, [open, preview?.key]);
    const icon = <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" aria-hidden="true">
      <path d="M14 3H6a1 1 0 0 0-1 1v16h14V8Zm0 0v5h5M8 12h8M8 16h6" />
    </svg>;
    const media = preview && (preview.kind === 'image'
      ? <img key={preview.key} className="cf-media" src={preview.url} alt="" data-loading={preview.loading}
        onLoad={preview.ready} onError={preview.failed} />
      : preview.kind === 'video'
        ? <video key={preview.key} className="cf-media" src={preview.url} preload="metadata" muted playsInline
          aria-hidden="true" onLoadedMetadata={preview.ready} onError={preview.failed} />
        : <><audio key={preview.key} className="cf-audio-probe" src={preview.url} preload="metadata"
          onLoadedMetadata={preview.ready} onError={preview.failed} />{icon}</>);
    return <span className="cf-card" role="group" aria-label={name} aria-busy={busy}>
      {preview ? <button type="button" className="cf-thumbnail cf-preview-button"
        aria-label={`${preview.kind === 'image' ? '查看' : '播放'} ${name}`} aria-haspopup="dialog"
        title={preview.kind === 'image' ? '查看图片' : '播放媒体'} onClick={() => setExpanded(preview.key)}>
        {media}
        {preview.kind !== 'image' && <span className="cf-play" aria-hidden="true">▶</span>}
      </button> : <span className="cf-thumbnail" aria-hidden="true">{icon}</span>}
      <span className="cf-card-details">
        <button type="button" className="cf-card-name" title={name} aria-label={`文件详情：${name}`} aria-haspopup="dialog"
          onClick={() => setExpanded(detailsKey)}>
          <span className="cf-name-stem" dir="auto">{stem}</span>{extension && <bdi className="cf-name-extension">{extension}</bdi>}
        </button>
        {error ? <button type="button" className="cf-card-status cf-error" title={error} aria-label={`查看文件错误：${error}`}
          aria-haspopup="dialog" onClick={() => setExpanded(detailsKey)}><span role="alert">文件异常 · 查看原因</span></button>
          : <span className="cf-card-status" title={information} role={busy ? 'status' : undefined}>{information}</span>}
        <span className="cf-progress-slot">
          {busy && <progress className="cf-progress" aria-label={`${name}：${status || '文件加载中'}`} />}
        </span>
      </span>
      <span className="cf-card-actions">{actions}</span>
      {open && <dialog ref={dialog} className="cf-preview-dialog" aria-label={`${detailsOpen ? '文件详情' : '预览'} ${name}`}
        onClose={() => setExpanded(undefined)}>
        <span className="cf-dialog-header">
          <span className="cf-dialog-name" dir="auto">{name}</span>
          <button type="button" className="cf-button" autoFocus onClick={() => dialog.current?.close()}>关闭预览</button>
        </span>
        {detailsOpen ? <div className="cf-file-information">
          {information && <p>{information}</p>}
          {error && <p className="cf-error">{error}</p>}
        </div> : preview?.kind === 'image' ? <img className="cf-expanded-media" src={preview.url} alt={name}
          onLoad={preview.ready} onError={preview.failed} />
          : preview?.kind === 'video' ? <video className="cf-expanded-media" src={preview.url} aria-label={name} controls preload="metadata"
            onLoadedMetadata={preview.ready} onError={preview.failed} />
            : preview?.kind === 'audio' ? <audio className="cf-expanded-media" src={preview.url} aria-label={name} controls preload="metadata"
              onLoadedMetadata={preview.ready} onError={preview.failed} /> : null}
      </dialog>}
    </span>;
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

  function FileCard({ url, name, actions, retry, status, busy, error, download = true }: CardProps & { url: string }) {
    const state = React.useSyncExternalStore(
      React.useCallback(listener => probes.subscribe(url, listener), [url]),
      React.useCallback(() => probes.snapshot(url), [url]),
    );
    const kind = state.mime ? previewKind(state.mime) : null;
    const loading = state.status === 'pending' || state.preview === 'pending';
    const mediaReady = () => probes.mediaReady(url, state.round);
    const mediaFailed = () => probes.mediaFailed(url, state.round);
    return <FileTile name={name} busy={busy ?? loading}
      status={status ? `${status}${loading && busy === undefined ? ' · 预览加载中' : ''}` : loading ? '文件加载中' : undefined}
      metadata={state.size !== undefined ? formatBytes(state.size) : state.mime}
      error={error || state.error}
      preview={state.status === 'ready' && state.preview !== 'failed' && kind ? {
        url, key: `${url}:${state.round}`, kind, loading: state.preview === 'pending', ready: mediaReady, failed: mediaFailed,
      } : undefined}
      actions={<>
        {retry ?? ((state.status === 'unavailable' || state.preview === 'failed') &&
          <button type="button" className="cf-icon-button" title="重试预览" onClick={() => probes.retry(url)}
            aria-label={`重新加载 ${name}`}><ActionIcon name="retry" /></button>)}
        {download && state.status === 'ready' && <a className="cf-download cf-icon-button" href={`${url}?download=1`} download={name}
          title="下载" aria-label={`下载 ${name}`}><ActionIcon name="download" /></a>}
        {actions}
      </>} />;
  }

  type BlobState = {
    data: string | undefined;
    mimeType: string;
    file?: File;
    deadline: number;
    preview: 'pending' | 'ready' | 'failed';
  } & ({ url: string; size: number; mime: string; error?: string } | { url?: undefined; error: string });

  function BlobCard({ attachment, file, name, actions, retry, status, busy, error: uploadError, download = true }: CardProps & {
    attachment?: NativeBlob; file?: File;
  }) {
    const [state, setState] = React.useState<BlobState>();
    const [round, setRound] = React.useState(0);
    const { data, mimeType, omittedReason } = attachment ?? { mimeType: file?.type || 'application/octet-stream' };
    const unavailable = file ? undefined : attachment ? unavailableBlobReason(attachment) : '原生未提供附件数据';
    React.useEffect(() => {
      if (disposed || context.signal.aborted || unavailable) {
        setState(undefined);
        return;
      }
      let url: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const release = () => {
        if (url) URL.revokeObjectURL(url);
        url = undefined;
        clearTimeout(timer);
        blobReleases.delete(release);
      };
      try {
        const blob = file ?? decodeNativeBlob({ type: 'blob', data, mimeType }, maxBytes);
        url = URL.createObjectURL(blob);
        const preview = previewKind(blob.type) ? 'pending' : 'ready';
        setState({ data, mimeType, file, url, size: blob.size, mime: blob.type, preview, deadline: Date.now() + 5_000 });
        if (preview === 'pending') timer = setTimeout(() => {
          if (!disposed) setState(previous => previous && previous.url === url && previous.preview === 'pending'
            ? { ...previous, preview: 'failed', error: '预览加载超时，仍可下载原件' } : previous);
        }, 5_000);
        blobReleases.add(release);
      } catch (error) {
        release();
        context.report(error);
        setState({ data, mimeType, file, preview: 'failed', deadline: 0,
          error: error instanceof Error ? error.message : '原生附件无法读取' });
      }
      return release;
    }, [data, mimeType, omittedReason, round, file]);
    const current = state?.data === data && state?.mimeType === mimeType && state?.file === file ? state : undefined;
    const error = unavailable ?? current?.error;
    const resource = !unavailable && current?.url ? current : undefined;
    const kind = resource?.mime ? previewKind(resource.mime) : null;
    const loading = !error && (!current || current.preview === 'pending');
    const mediaResult = (ready: boolean) => {
      if (disposed || !resource) return;
      setState(previous => {
        if (previous?.url !== resource.url || (ready && previous.preview !== 'pending')) return previous;
        const available = ready && Date.now() < previous.deadline;
        return { ...previous, preview: available ? 'ready' : 'failed',
          ...(available ? {} : { error: '无法预览，仍可下载原件' }) };
      });
    };
    return <FileTile name={name} busy={busy ?? loading}
      status={status ? `${status}${loading && busy === undefined ? ' · 预览加载中' : ''}` : loading ? '文件加载中' : undefined}
      metadata={resource ? formatBytes(resource.size) : file ? formatBytes(file.size) : undefined}
      error={uploadError || (error ? `${resource ? '' : '附件不可用：'}${error}` : undefined)}
      preview={kind && resource && resource.preview !== 'failed' ? {
        url: resource.url, key: resource.url, kind, loading, ready: () => mediaResult(true), failed: () => mediaResult(false),
      } : undefined}
      actions={<>
        {retry ?? (resource?.preview === 'failed' &&
          <button type="button" className="cf-icon-button" title="重试预览" onClick={() => setRound(value => value + 1)}
            aria-label={`重新加载 ${name}`}><ActionIcon name="retry" /></button>)}
        {download && resource && <a className="cf-download cf-icon-button" href={resource.url} download={name}
          title="下载" aria-label={`下载 ${name}`}><ActionIcon name="download" /></a>}
        {actions}
      </>} />;
  }

  function FileRenderer({ node }: { node: RenderNode }) {
    if (node.kind === 'attachment' && node.attachment?.type === 'blob') {
      return <BlobCard attachment={node.attachment} name={node.label || node.attachment.displayName || '附件'} />;
    }
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
    for (const release of [...blobReleases]) release();
  }
  context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose();
  const frontend: ModuleFrontend = {
    writes: ['attachments'],
    composerActions: [{ id: 'upload', component: UploadAction }],
    composerAbove: [{ id: 'attachments', component: AttachmentList }],
    rendersDraftAttachments: true,
    fileInput: [{
      id: 'upload',
      accepts: files => !disposed && !!nativePathPrefix && files.length > 0,
      receive: (files, composer) => uploads.receive(files, composer),
    }],
    chatRenderers: [{
      id: 'files',
      matches: node => !disposed && ((node.kind === 'attachment' && node.attachment?.type === 'blob') || nodeUrl(node) !== null),
      component: FileRenderer,
    }],
    dispose,
  };
  return frontend;
};
