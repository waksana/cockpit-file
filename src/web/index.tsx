import type {
  ActivateFrontend, ComposerContext, ModuleDraft, ModuleFrontend, RenderNode,
} from '@cockpit/module-api';
import type { ReactNode } from 'react';
import { isLocalFileReference, messageFileUrl, nativeFileUrl } from '../shared/files.ts';
import { DEFAULT_MAX_BYTES, FileProbes, formatBytes, previewKind, UploadStore } from './file-state.ts';
import { decodeNativeBlob, unavailableBlobReason, type NativeBlob } from './blob.ts';
import { icons } from './icons.ts';

export const activate: ActivateFrontend = context => {
  if (context.uiVersion !== 1 || typeof context.createPortal !== 'function') {
    throw new Error('Cockpit File requires host Module UI v1 and context.createPortal; upgrade the paired host first.');
  }
  const createPortal = context.createPortal;
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

  function Icon({ name, small = false }: { name: keyof typeof icons; small?: boolean }) {
    return <svg className={`ck-icon${small ? ' ck-icon-md' : ''}`} width="24" height="24" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {icons[name].map(([tag, attributes], key) => React.createElement(tag, { ...attributes, key }))}
    </svg>;
  }

  function ActionIcon({ name }: { name: 'remove' | 'download' | 'retry' }) {
    return <Icon small name={name === 'remove' ? 'x' : name === 'retry' ? 'rotate-cw' : 'download'} />;
  }

  function UploadAction(composer: ComposerContext) {
    const input = React.useRef<HTMLInputElement>(null);
    const selectionContext = React.useRef<ComposerContext | null>(null);
    const draft = useDraft(composer.draft);
    const disabled = composer.disabled || draft.pending || composer.operation !== 'prompt' || !nativePathPrefix || context.signal.aborted;
    return <span className="cf-upload-action">
      <button
        type="button"
        className="ck-icon-button"
        disabled={disabled}
        title={composer.operation === 'prompt' ? `添加文件（单个最多 ${formatBytes(maxBytes)}）` : '当前操作不接受附件'}
        aria-label="添加文件"
        onClick={() => {
          selectionContext.current = composer;
          input.current?.click();
        }}
      >
        <Icon name="paperclip" />
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
          const actions = <button type="button" className="ck-icon-button ck-danger" disabled={disabled} title="移除"
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
          const retry = item.status === 'failed' ? <button type="button" className="ck-icon-button" title="重试上传"
            disabled={disabled || composer.operation !== 'prompt'}
            onClick={() => uploads.retry(composer.draft, item.id)} aria-label={`重新上传 ${item.name}`}><ActionIcon name="retry" /></button> : undefined;
          const actions = <button type="button" className="ck-icon-button ck-danger" disabled={disabled} title="移除"
            onClick={() => uploads.remove(composer.draft, item.id)} aria-label={`移除 ${item.name}`}><ActionIcon name="remove" /></button>;
          const props = {
            name: item.name, actions, retry, download: false, error: item.error,
            errorLabel: '上传失败',
            busy: item.status === 'uploading',
            status: item.status === 'uploading' ? '上传中' : item.status === 'ready' ? '已上传，等待加入草稿' : '上传未完成',
          };
          return <li className="cf-attachment" key={item.id}>
            {item.url ? <FileCard {...props} url={item.url} />
              : item.file && previewKind(item.file.type) === 'image'
                ? <BlobCard {...props} file={item.file} />
                : <FileTile {...props} metadata={formatBytes(item.size)} />}
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
    errorLabel?: string;
    busy?: boolean;
    download?: boolean;
    inline?: boolean;
  }

  interface Preview {
    url: string;
    key: string;
    kind: 'image' | 'video' | 'audio';
  }

  interface MediaRun {
    key: string;
    resource: string;
    deadline: number;
    status: 'pending' | 'ready' | 'failed';
    timeout?: ReturnType<typeof setTimeout>;
  }

  function FileTile({ name, status, error, errorLabel = '文件异常', busy = false, metadata, actions, retry,
    preview, inline = false, href, downloadUrl, identity = name }: CardProps & {
    metadata?: string; preview?: Preview; href?: string; downloadUrl?: string; identity?: string | object;
  }) {
    if (inline && !href) throw new Error('An inline file reference requires its canonical resource URL');
    const [expanded, setExpanded] = React.useState<{ identity: string | object; revision: number }>();
    const sequence = React.useRef(0);
    const dialog = React.useRef<HTMLDialogElement>(null);
    const rowTrigger = React.useRef<HTMLButtonElement>(null);
    const open = expanded?.identity === identity;
    const [attempt, setAttempt] = React.useState(0);
    const [media, setMedia] = React.useState<{ resource: string; status: 'pending' | 'ready' | 'failed'; error?: string }>();
    const run = React.useRef<MediaRun | undefined>(undefined);
    const mediaKey = open && preview ? `${preview.key}:${expanded.revision}:${attempt}` : undefined;
    const currentMedia = preview && media?.resource === preview.key ? media : undefined;
    const mediaError = currentMedia?.status === 'failed' ? currentMedia.error : undefined;
    const mediaLoading = !!mediaKey && (!currentMedia || currentMedia.status === 'pending');
    const failure = error || mediaError;
    const label = preview ? `${preview.kind === 'image' ? '查看' : '播放'} ${name}` : `文件详情：${name}`;
    const suffix = /(?:\.tar\.(?:gz|bz2|xz|zst)|\.[a-z0-9]{1,10})$/i.exec(name);
    const extension = suffix && suffix.index > 0 ? suffix[0] : '';
    const stem = extension ? name.slice(0, -extension.length) : name;
    const information = [status, metadata].filter(Boolean).join(' · ');
    const summary = error ? errorLabel : mediaError ? '预览失败' : mediaLoading ? '预览中'
      : busy ? status || '检查中' : status && status !== '准备就绪' ? status : metadata || status || '文件';
    const fileIcon = preview?.kind === 'image' ? 'image' : preview?.kind === 'video' || preview?.kind === 'audio' ? 'play'
      : /\.(?:[cm]?[jt]sx?|py|go|rs|java|sh|css|json|ya?ml|toml)(?:[:#].*)?$/i.test(name) ? 'file-code' : 'file';
    const begin = () => {
      if (context.signal.aborted) return;
      setMedia(undefined);
      setExpanded({ identity, revision: ++sequence.current });
    };
    const mediaResult = (key: string | undefined, ready: boolean) => {
      const active = run.current;
      if (!active || active.key !== key || context.signal.aborted || active.status === 'failed' ||
          (ready && active.status === 'ready')) return;
      clearTimeout(active.timeout);
      const timedOut = ready && Date.now() >= active.deadline;
      active.status = ready && !timedOut ? 'ready' : 'failed';
      setMedia({ resource: active.resource, status: active.status,
        ...(active.status === 'failed' ? { error: timedOut
          ? '预览加载超时，原件仍可下载。可以重试预览。'
          : '图片或媒体未能显示，原件仍可下载。可以重试预览。' } : {}) });
    };
    React.useLayoutEffect(() => {
      if (!mediaKey || !preview || context.signal.aborted) return;
      const active: MediaRun = { key: mediaKey, resource: preview.key, deadline: Date.now() + 5_000, status: 'pending' };
      run.current = active;
      setMedia({ resource: preview.key, status: 'pending' });
      active.timeout = setTimeout(() => {
        if (run.current !== active || context.signal.aborted) return;
        run.current.status = 'failed';
        setMedia({ resource: active.resource, status: 'failed', error: '预览加载超时，原件仍可下载。可以重试预览。' });
      }, 5_000);
      return () => {
        clearTimeout(active.timeout);
        if (run.current === active) run.current = undefined;
      };
    }, [mediaKey]);
    React.useEffect(() => {
      if (!open || context.signal.aborted) return;
      const element = dialog.current;
      element?.showModal();
      const close = () => element?.close();
      context.signal.addEventListener('abort', close, { once: true });
      return () => {
        context.signal.removeEventListener('abort', close);
        close();
      };
    }, [open, expanded]);
    const previewRetry = mediaError && <button type="button" className="ck-icon-button" title="重试预览"
      aria-label={`重新加载 ${name}`} onClick={() => {
        if (context.signal.aborted) return;
        setMedia(undefined);
        setAttempt(value => value + 1);
        if (!open) {
          rowTrigger.current?.focus({ preventScroll: true });
          begin();
        }
      }}><ActionIcon name="retry" /></button>;
    const retryAction = retry || previewRetry;
    const downloadAction = downloadUrl && <a className="ck-icon-button" href={downloadUrl} download={name}
      title="下载" aria-label={`下载 ${name}`}><ActionIcon name="download" /></a>;
    return <span className={inline ? 'cf-reference' : 'cf-row'} aria-busy={busy || mediaLoading}>
      {inline ? <a className="cf-reference-link" href={href} aria-label={label} aria-haspopup="dialog"
        aria-description={failure || information} title={failure || name}
        onClick={event => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
          event.preventDefault();
          begin();
        }}>
        <span className="cf-reference-icon" aria-hidden="true"><Icon name={fileIcon} /></span>
        <span className="cf-reference-name">{name}</span>
        <span className={`cf-reference-state${failure ? ' cf-error' : ''}`} aria-hidden="true">
          <Icon name={failure ? 'circle-alert' : busy || mediaLoading ? 'loader-circle' : 'arrow-up-right'} />
        </span>
      </a> : <>
        <button ref={rowTrigger} type="button" className="ck-button cf-row-open" aria-label={label} aria-haspopup="dialog"
          aria-description={failure || information} title={name} onClick={begin}>
          <span className="cf-file-icon" aria-hidden="true"><Icon small name={fileIcon} /></span>
          <span className="cf-row-name">
            <span className="cf-name-stem" dir="auto">{stem}</span>{extension && <bdi className="cf-name-extension">{extension}</bdi>}
          </span>
          <span className={`cf-row-status${failure ? ' cf-error' : ''}`} title={failure || information}>{summary}</span>
          {(busy || mediaLoading) && <progress className="cf-progress" aria-label={`${name}：${summary}`} />}
        </button>
        <span className="cf-row-actions">
          <span className="cf-action-slot">{retryAction}</span>
          <span className="cf-action-slot">{actions || downloadAction}</span>
        </span>
      </>}
      {failure && <span className="cf-announcement" role="alert">{failure}</span>}
      {open && page?.body && createPortal(<dialog key={expanded.revision} ref={dialog} className="cf-preview-dialog" aria-label={`${preview && !failure ? '预览' : '文件详情'} ${name}`}
        onClose={() => setExpanded(current => current === expanded ? undefined : current)}>
        <span className="cf-dialog-header">
          <span className="cf-dialog-name" dir="auto">{name}</span>
          <button type="button" className="ck-button" autoFocus onClick={() => dialog.current?.close()}>
            <Icon small name="x" />
            {preview && !failure ? '关闭预览' : '关闭详情'}
          </button>
        </span>
        <div className="cf-file-information">
          {information && <p>{information}</p>}
          {failure && <p className="cf-error" role="alert">{failure}</p>}
          {busy && <p role="status">{status || '正在检查文件状态…'}</p>}
          {!busy && !preview && !failure && <p>此类型暂不支持预览。{downloadUrl ? '可以下载原件查看。' : ''}</p>}
        </div>
        {preview && !mediaError && (preview.kind === 'image' ? <img key={mediaKey} className="cf-expanded-media"
          src={preview.url} alt={name} onLoad={() => mediaResult(mediaKey, true)} onError={() => mediaResult(mediaKey, false)} />
          : preview.kind === 'video' ? <video key={mediaKey} className="cf-expanded-media" src={preview.url} aria-label={name}
            controls preload="metadata" onLoadedMetadata={() => mediaResult(mediaKey, true)} onError={() => mediaResult(mediaKey, false)} />
            : <audio key={mediaKey} className="cf-expanded-media" src={preview.url} aria-label={name} controls preload="metadata"
              onLoadedMetadata={() => mediaResult(mediaKey, true)} onError={() => mediaResult(mediaKey, false)} />)}
        <div className="cf-dialog-actions">{retryAction}{downloadAction}{actions}</div>
      </dialog>, page.body)}
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

  function FileCard({ url, name, actions, retry, status, busy, error, errorLabel, inline, download = true }: CardProps & { url: string }) {
    const state = React.useSyncExternalStore(
      React.useCallback(listener => probes.subscribe(url, listener), [url]),
      React.useCallback(() => probes.snapshot(url), [url]),
    );
    const kind = state.mime ? previewKind(state.mime) : null;
    const loading = state.status === 'pending';
    const checkErrorLabel = state.failure?.kind === 'timeout' ? '检查超时'
      : state.failure?.kind === 'network' ? '请求失败'
        : state.failure?.kind === 'http' && [401, 403].includes(state.failure.status) ? '无访问权限'
          : state.failure?.kind === 'http' && state.failure.status === 422 ? '捕获失败' : '检查失败';
    return <FileTile name={name} identity={url} href={url} inline={inline} busy={busy ?? loading}
      status={status || (loading ? '检查中' : undefined)}
      metadata={state.size !== undefined ? formatBytes(state.size) : state.mime}
      error={error || state.error}
      errorLabel={error ? errorLabel : checkErrorLabel}
      preview={state.status === 'ready' && kind ? {
        url, key: `${url}:${state.round}`, kind,
      } : undefined}
      retry={retry ?? (state.status === 'unavailable' &&
          <button type="button" className="ck-icon-button" title="重试预览" onClick={() => probes.retry(url)}
            aria-label={`重新加载 ${name}`}><ActionIcon name="retry" /></button>)}
      downloadUrl={download && state.status === 'ready' ? `${url}?download=1` : undefined}
      actions={actions} />;
  }

  type BlobState = {
    data: string | undefined;
    mimeType: string;
    file?: File;
  } & ({ url: string; size: number; mime: string; error?: string } | { url?: undefined; error: string });

  function BlobCard({ attachment, file, name, actions, retry, status, busy, error: uploadError, errorLabel, download = true }: CardProps & {
    attachment?: NativeBlob; file?: File;
  }) {
    const [state, setState] = React.useState<BlobState>();
    const { data, mimeType, omittedReason } = attachment ?? { mimeType: file?.type || 'application/octet-stream' };
    const identity = React.useMemo(() => ({}), [file, data, mimeType, omittedReason]);
    const unavailable = file ? undefined : attachment ? unavailableBlobReason(attachment) : '原生未提供附件数据';
    React.useEffect(() => {
      if (disposed || context.signal.aborted || unavailable) {
        setState(undefined);
        return;
      }
      let url: string | undefined;
      const release = () => {
        if (url) URL.revokeObjectURL(url);
        url = undefined;
        blobReleases.delete(release);
      };
      try {
        const blob = file ?? decodeNativeBlob({ type: 'blob', data, mimeType }, maxBytes);
        url = URL.createObjectURL(blob);
        setState({ data, mimeType, file, url, size: blob.size, mime: blob.type });
        blobReleases.add(release);
      } catch (error) {
        release();
        context.report(error);
        setState({ data, mimeType, file,
          error: error instanceof Error ? error.message : '原生附件无法读取' });
      }
      return release;
    }, [data, mimeType, omittedReason, file]);
    const current = state?.data === data && state?.mimeType === mimeType && state?.file === file ? state : undefined;
    const error = unavailable ?? current?.error;
    const resource = !unavailable && current?.url ? current : undefined;
    const kind = resource?.mime ? previewKind(resource.mime) : null;
    const loading = !error && !current;
    return <FileTile name={name} identity={identity} busy={busy ?? loading}
      status={status || (loading ? '检查中' : undefined)}
      metadata={resource ? formatBytes(resource.size) : file ? formatBytes(file.size) : undefined}
      error={uploadError || (error ? `${resource ? '' : '附件不可用：'}${error}` : undefined)}
      errorLabel={uploadError ? errorLabel : '附件不可用'}
      preview={kind && resource ? {
        url: resource.url, key: resource.url, kind,
      } : undefined}
      retry={retry} downloadUrl={download && resource ? resource.url : undefined} actions={actions} />;
  }

  function FileRenderer({ node }: { node: RenderNode }) {
    if (node.kind === 'attachment' && node.attachment?.type === 'blob') {
      return <BlobCard attachment={node.attachment} name={node.label || node.attachment.displayName || '附件'} />;
    }
    const url = nodeUrl(node);
    if (!url) return <span>{node.label}</span>;
    return <FileCard key={url} url={url} inline={node.kind !== 'attachment'} name={node.label || node.attachment?.displayName || '文件'} />;
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
