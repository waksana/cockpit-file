import type {
  ActivateNextFrontend, AttachmentProps, DraftReference, MarkdownNode, MarkdownRendererProps,
} from '@cockpit/module-api';
import type { ReactNode, SyntheticEvent } from 'react';
import { isLocalFileReference, messageFileUrl, nativeFileUrl } from '../../shared/files.ts';
import { decodeNativeBlob, unavailableBlobReason, type NativeBlob } from '../blob.ts';
import { type FileComposerContext, type FileDraft } from '../file-draft.ts';
import { createFileServices } from '../file-services.ts';
import { formatBytes, previewKind } from '../file-state.ts';
import { icons } from '../icons.ts';

export const activate: ActivateNextFrontend = context => {
  if (context.apiVersion !== 2 || context.ui?.version !== 1 || typeof context.state?.registerDraft !== 'function') {
    throw new Error('Cockpit File new UI requires Web API v2, public React UI v1 and draft schemas.');
  }
  const React = context.react;
  const { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, Alert, AlertDescription } = context.ui;
  const services = createFileServices(context);
  const { uploads, probes, inputs, fileDrafts, nativePathPrefix, maxBytes, resources } = services;
  const uploadTriggers = new Map<string, HTMLButtonElement>();
  resources.add(() => uploadTriggers.clear());

  function useDraft(draft: DraftReference) {
    return React.useSyncExternalStore(
      React.useCallback(listener => draft.subscribe(listener), [draft]),
      React.useCallback(() => draft.getSnapshot(), [draft]),
    );
  }

  function useUploads(draft: FileDraft) {
    return React.useSyncExternalStore(
      React.useCallback(listener => uploads.subscribe(draft, listener), [draft]),
      React.useCallback(() => uploads.snapshot(draft), [draft]),
    );
  }

  function Icon({ name }: { name: keyof typeof icons }) {
    return <svg className="cfn-icon" width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {icons[name].map(([tag, attributes], key) => React.createElement(tag, { ...attributes, key }))}
    </svg>;
  }

  interface ItemProps {
    name: string;
    status?: string;
    error?: string;
    busy?: boolean;
    actions?: ReactNode;
    retry?: ReactNode;
    download?: boolean;
    inline?: boolean;
    restoreFocus?: () => void;
  }

  interface Preview {
    url: string;
    key: string;
    kind: 'image' | 'video' | 'audio';
  }

  function FileItem({ name, status, error, busy = false, actions, retry, inline = false, metadata,
    preview, href, downloadUrl, restoreFocus, identity = href ?? name }: ItemProps & {
    metadata?: string; preview?: Preview; href?: string; downloadUrl?: string; identity?: string | object;
  }) {
    const [expanded, setExpanded] = React.useState<{ identity: string | object; revision: number }>();
    const sequence = React.useRef(0);
    const trigger = React.useRef<HTMLElement | null>(null);
    const content = React.useRef<HTMLDivElement>(null);
    const [attempt, setAttempt] = React.useState(0);
    const [media, setMedia] = React.useState<{ key: string; status: 'pending' | 'ready' | 'failed'; error?: string }>();
    const run = React.useRef<{
      key: string; deadline: number; status: 'pending' | 'ready' | 'failed'; timer?: ReturnType<typeof setTimeout>;
    } | undefined>(undefined);
    const open = expanded?.identity === identity && !services.disposed && !context.signal.aborted;
    const mediaKey = open && preview ? `${preview.key}:${expanded.revision}:${attempt}` : undefined;
    const currentMedia = media?.key === mediaKey ? media : undefined;
    const mediaError = currentMedia?.error;
    const loading = !!mediaKey && (!currentMedia || currentMedia.status === 'pending');
    const failure = error || mediaError;
    const information = [status, metadata].filter(Boolean).join(' · ');
    const label = preview ? `${preview.kind === 'image' ? '预览' : '播放'} ${name}` : `文件详情：${name}`;
    const begin = () => {
      if (services.disposed || context.signal.aborted) return;
      setMedia(undefined);
      setExpanded({ identity, revision: ++sequence.current });
    };
    const mediaResult = (key: string | undefined, success: boolean) => {
      const active = run.current;
      if (!active || active.key !== key || active.status === 'failed' || context.signal.aborted ||
          (success && active.status === 'ready')) return;
      clearTimeout(active.timer);
      const timedOut = active.status === 'pending' && Date.now() >= active.deadline;
      active.status = !success || timedOut ? 'failed' : 'ready';
      setMedia({ key: active.key, status: active.status,
        ...(active.status === 'failed' ? { error: timedOut
          ? '预览加载超时。原件仍可下载，也可以重试预览。'
          : '图片或媒体无法显示。原件仍可下载，也可以重试预览。' } : {}) });
    };
    React.useLayoutEffect(() => {
      if (!mediaKey || context.signal.aborted) return;
      const active: NonNullable<typeof run.current> = { key: mediaKey, deadline: Date.now() + 5_000, status: 'pending' };
      run.current = active;
      setMedia({ key: mediaKey, status: 'pending' });
      active.timer = setTimeout(() => {
        if (run.current === active) mediaResult(active.key, false);
      }, 5_000);
      return () => {
        clearTimeout(active.timer);
        if (run.current === active) run.current = undefined;
      };
    }, [mediaKey]);
    React.useEffect(() => {
      const stop = () => setExpanded(undefined);
      context.signal.addEventListener('abort', stop, { once: true });
      return () => context.signal.removeEventListener('abort', stop);
    }, []);
    const retryMedia = mediaError && <Button type="button" variant="outline" onClick={() => {
      if (context.signal.aborted) return;
      setMedia(undefined);
      setAttempt(value => value + 1);
    }} aria-label={`重新加载 ${name}`}><Icon name="rotate-cw" />重试预览</Button>;
    const retryAction = retry || retryMedia;
    const downloadAction = downloadUrl && <Button variant="outline" asChild>
      <a href={downloadUrl} download={name} aria-label={`下载 ${name}`}><Icon name="download" />下载</a>
    </Button>;
    const icon = preview?.kind === 'image' ? 'image' : preview ? 'play' : 'file';
    return <Dialog open={open} onOpenChange={value => {
      if (value) begin();
      else setExpanded(current => current === expanded ? undefined : current);
    }}>
      <span className={inline ? 'cfn-reference' : 'cfn-item'} aria-busy={busy || loading}>
        {inline ? <a ref={element => { trigger.current = element; }} className="cfn-reference-link"
          href={href} aria-haspopup="dialog" aria-label={label} aria-description={failure || information}
          onClick={event => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
            event.preventDefault();
            begin();
          }}>{name}<span className="cfn-reference-status" aria-hidden="true">
            <Icon name={failure ? 'circle-alert' : busy || loading ? 'loader-circle' : 'arrow-up-right'} />
          </span></a> : <>
          <Button ref={element => { trigger.current = element; }} type="button" variant="ghost" className="cfn-item-open"
            aria-haspopup="dialog" aria-label={label} aria-description={failure || information} onClick={begin}>
            <Icon name={icon} />
            <span className="cfn-item-copy">
              <span className="cfn-name" dir="auto">{name}</span>
              <span className="cfn-detail">{information || '文件'}</span>
            </span>
          </Button>
          <span className="cfn-item-actions">{retry}{actions || downloadAction}</span>
          {busy && <progress className="cfn-progress" aria-label={`${name}：${status || '检查中'}`} />}
          {error && <span className="cfn-item-error" role="alert">{error}</span>}
        </>}
        {inline && error && <span className="cfn-sr-only" role="alert">{error}</span>}
        {open && <DialogContent ref={content} tabIndex={-1} className="cfn-dialog"
          style={{ width: 'min(48rem, calc(100vw - 2rem))', maxWidth: 'calc(100vw - 2rem)' }}
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (context.signal.aborted || sequence.current !== expanded.revision) return;
            if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
            else restoreFocus?.();
          }}>
          <DialogHeader>
            <DialogTitle className="cfn-name" dir="auto">{name}</DialogTitle>
            <DialogDescription>{information || '文件详情'}</DialogDescription>
          </DialogHeader>
          {failure && <Alert variant="destructive"><AlertDescription>{failure}</AlertDescription></Alert>}
          {(busy || loading) && <p className="cfn-detail" role="status">{loading ? '正在加载预览…' : status || '正在检查文件…'}</p>}
          {!busy && !preview && !failure && <p className="cfn-detail">此类型暂不支持预览。{downloadUrl ? '可以下载原件查看。' : ''}</p>}
          {preview && !mediaError && (preview.kind === 'image'
            ? <img key={mediaKey} className="cfn-media" src={preview.url} alt={name}
              onLoad={() => mediaResult(mediaKey, true)} onError={() => mediaResult(mediaKey, false)} />
            : preview.kind === 'video'
              ? <video key={mediaKey} className="cfn-media" src={preview.url} aria-label={name} controls preload="metadata"
                onLoadedMetadata={() => mediaResult(mediaKey, true)} onError={() => mediaResult(mediaKey, false)} />
              : <audio key={mediaKey} className="cfn-media" src={preview.url} aria-label={name} controls preload="metadata"
                onLoadedMetadata={() => mediaResult(mediaKey, true)} onError={() => mediaResult(mediaKey, false)} />)}
          <DialogFooter>
            {retryAction && <span className="cfn-retry" onClickCapture={event => {
              if (event.currentTarget.contains(event.currentTarget.ownerDocument.activeElement)) {
                content.current?.focus({ preventScroll: true });
              }
            }}>{retryAction}</span>}
            {downloadAction}{actions}
          </DialogFooter>
        </DialogContent>}
      </span>
    </Dialog>;
  }

  function FileCard({ url, error, busy, status, retry, download = true, ...props }: ItemProps & { url: string }) {
    const state = React.useSyncExternalStore(
      React.useCallback(listener => probes.subscribe(url, listener), [url]),
      React.useCallback(() => probes.snapshot(url), [url]),
    );
    const kind = state.mime ? previewKind(state.mime) : null;
    return <FileItem {...props} identity={url} href={url}
      busy={busy ?? state.status === 'pending'} status={status || (state.status === 'pending' ? '检查中' : undefined)}
      metadata={state.size !== undefined ? formatBytes(state.size) : state.mime}
      error={error || state.error} preview={state.status === 'ready' && kind ? { url, key: `${url}:${state.round}`, kind } : undefined}
      downloadUrl={download && state.status === 'ready' ? `${url}?download=1` : undefined}
      retry={retry ?? (state.status === 'unavailable' && <Button type="button" variant="outline"
        onClick={() => probes.retry(url)} aria-label={`重新加载 ${props.name}`}><Icon name="rotate-cw" />重新检查</Button>)} />;
  }

  function BlobCard({ attachment, file, error, download = true, ...props }: ItemProps & { attachment?: NativeBlob; file?: File }) {
    const { data, mimeType, omittedReason } = attachment ?? { mimeType: file?.type || 'application/octet-stream' };
    const identity = React.useMemo(() => ({}), [data, mimeType, omittedReason, file]);
    const [resource, setResource] = React.useState<{
      identity: object; url?: string; mime?: string; size?: number; error?: string;
    }>();
    const unavailable = file ? undefined : attachment ? unavailableBlobReason(attachment) : '原生未提供附件数据';
    React.useEffect(() => {
      if (services.disposed || context.signal.aborted || unavailable) return;
      let url: string | undefined;
      const release = () => {
        if (url) URL.revokeObjectURL(url);
        url = undefined;
        resources.delete(release);
      };
      try {
        const blob = file ?? decodeNativeBlob({ type: 'blob', data, mimeType }, maxBytes);
        url = URL.createObjectURL(blob);
        resources.add(release);
        setResource({ identity, url, mime: blob.type, size: blob.size });
      } catch (cause) {
        release();
        context.report(cause);
        setResource({ identity, error: cause instanceof Error ? cause.message : '原生附件无法读取' });
      }
      return release;
    }, [identity]);
    const current = resource?.identity === identity ? resource : undefined;
    const failure = unavailable || current?.error;
    const kind = current?.mime ? previewKind(current.mime) : null;
    return <FileItem {...props} identity={identity} error={error || failure}
      busy={props.busy ?? (!failure && !current)}
      metadata={current?.size !== undefined ? formatBytes(current.size) : file ? formatBytes(file.size) : undefined}
      preview={!failure && current?.url && kind ? { url: current.url, key: current.url, kind } : undefined}
      downloadUrl={download && !failure ? current?.url : undefined} />;
  }

  function AttachmentTray(composer: FileComposerContext) {
    useDraft(composer.draft);
    const draft = composer.draft.getSnapshot();
    const pending = useUploads(composer.draft);
    const disabled = composer.disabled || draft.pending;
    const restoreFocus = () => {
      const button = uploadTriggers.get(composer.draft.id);
      if (button?.isConnected) button.focus({ preventScroll: true });
    };
    if (!draft.attachments.length && !pending.items.length && !pending.error) return null;
    return <section className="cfn-tray" aria-label="文件附件">
      <h3 className="cfn-tray-heading">附件 <span className="cfn-detail">{draft.attachments.length + pending.items.length}</span></h3>
      {pending.error && <Alert variant="destructive"><AlertDescription>{pending.error}</AlertDescription></Alert>}
      <ul className="cfn-list">
        {draft.attachments.map(item => {
          const name = item.value.displayName || '附件';
          const props: ItemProps = { name, status: draft.pending ? '正在提交' : '准备就绪', download: false, restoreFocus,
            actions: <Button type="button" variant="ghost" size="icon" disabled={disabled} title="移除附件"
              aria-label={`移除 ${name}`} onClick={() => uploads.removeAttachment(composer.draft, item.id)}><Icon name="x" /></Button> };
          const url = item.value.type === 'file' ? nativeFileUrl(item.value.path, nativePathPrefix, context.apiBase) : null;
          return <li key={item.id}>{url ? <FileCard {...props} url={url} />
            : item.value.type === 'blob' ? <BlobCard {...props} attachment={item.value} /> : <FileItem {...props} />}</li>;
        })}
        {pending.items.map(item => {
          const props: ItemProps = {
            name: item.name, download: false, busy: item.status === 'uploading', error: item.error, restoreFocus,
            status: item.status === 'uploading' ? '上传中' : item.status === 'ready' ? '已上传，等待加入草稿' : '上传未完成',
            retry: item.status === 'failed' && <Button type="button" variant="outline" disabled={disabled || composer.operation !== 'prompt'}
              aria-label={`重新上传 ${item.name}`} onClick={() => uploads.retry(composer.draft, item.id)}><Icon name="rotate-cw" />重试</Button>,
            actions: <Button type="button" variant="ghost" size="icon" disabled={disabled}
              title={item.status === 'uploading' ? '取消上传' : '移除附件'} aria-label={`移除 ${item.name}`}
              onClick={() => uploads.remove(composer.draft, item.id)}><Icon name="x" /></Button>,
          };
          return <li key={item.id}>{item.url ? <FileCard {...props} url={item.url} />
            : item.file && previewKind(item.file.type) === 'image' ? <BlobCard {...props} file={item.file} />
              : <FileItem {...props} metadata={formatBytes(item.size)} />}</li>;
        })}
      </ul>
    </section>;
  }

  function UploadAction(composer: FileComposerContext) {
    const draft = useDraft(composer.draft);
    const disabled = composer.disabled || draft.pending || composer.operation !== 'prompt' || !nativePathPrefix || context.signal.aborted;
    return <Button ref={element => {
      if (element) uploadTriggers.set(composer.draft.id, element);
      else uploadTriggers.delete(composer.draft.id);
    }} type="button" variant="ghost" size="icon" disabled={disabled} aria-label="添加文件"
      title={`添加文件（单个最多 ${formatBytes(maxBytes)}）`}
      onClick={() => { if (!disabled && !services.disposed) inputs.pick(composer); }}><Icon name="paperclip" /></Button>;
  }

  function composeInput<Event extends SyntheticEvent>(
    inherited: ((event: Event) => void) | undefined, handle: (event: Event) => void,
  ) {
    return (event: Event) => {
      try {
        inherited?.(event);
        if (!event.defaultPrevented) handle(event);
      } catch (error) { context.report(error); }
    };
  }

  function nodeUrl(node: MarkdownNode): string | null {
    if (!node.target || !isLocalFileReference(node.target)) return null;
    try { return messageFileUrl(context.apiBase, node.origin, node.target); }
    catch { return null; }
  }

  function FileRenderer({ node, fallback }: MarkdownRendererProps) {
    const url = nodeUrl(node);
    return url ? <FileCard key={url} url={url} inline name={node.label || '文件'} /> : fallback;
  }

  function AttachmentCard({ attachment, label, actions, url }: AttachmentProps & { url?: string }) {
    const props = { name: label || attachment.displayName || '附件', actions };
    return attachment.type === 'blob' ? <BlobCard {...props} attachment={attachment} />
      : url ? <FileCard {...props} url={url} /> : <FileItem {...props} />;
  }

  return {
    apiVersion: 2,
    components: [{
      id: 'file-composer', boundary: 'composer',
      wrap: Base => function FileComposer(props) {
        if (services.disposed) return <Base {...props} />;
        const draft = fileDrafts.get(props.draft);
        return draft ? <Base {...props} children={<>{props.children}
          <AttachmentTray draft={draft} operation={props.operation} disabled={props.disabled} /></>} /> : <Base {...props} />;
      },
    }, {
      id: 'file-editor', boundary: 'composerEditor',
      wrap: Base => function FileEditor(props) {
        if (services.disposed || props.operation !== 'prompt') return <Base {...props} />;
        const draft = fileDrafts.get(props.draft);
        if (!draft) return <Base {...props} />;
        const composer = { draft, operation: props.operation, disabled: props.disabled };
        return <Base {...props} children={<>{props.children}<UploadAction {...composer} /></>}
          onPaste={composeInput(props.onPaste, event => inputs.paste(event, composer))}
          onDrop={composeInput(props.onDrop, event => inputs.drop(event, composer))}
          onDragOver={composeInput(props.onDragOver, event => inputs.dragOver(event, composer))} />;
      },
    }, {
      id: 'file-attachment', boundary: 'attachment',
      wrap: Base => function FileAttachment(props) {
        const url = props.attachment.type === 'file' ? nativeFileUrl(props.attachment.path, nativePathPrefix, context.apiBase) : null;
        return services.disposed || (props.attachment.type !== 'blob' && !url) ? <Base {...props} />
          : <AttachmentCard {...props} url={url ?? undefined} />;
      },
    }],
    markdown: [{ id: 'file-markdown', matches: node => !services.disposed && nodeUrl(node) !== null, component: FileRenderer }],
    dispose: services.dispose,
  };
};
