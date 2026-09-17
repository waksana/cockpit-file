import type { ModuleFrontendContext } from '@cockpit/module-api';
import type { ClipboardEvent, DragEvent } from 'react';
import type { FileComposerContext } from './file-draft.ts';
import type { UploadStore } from './file-state.ts';

interface FileInputOptions {
  readonly uploads: Pick<UploadStore, 'receive'>;
  readonly report: ModuleFrontendContext['report'];
  readonly signal: AbortSignal;
  readonly page?: Pick<Document, 'createElement'>;
  readonly enabled: boolean;
}

interface Picker {
  input?: HTMLInputElement;
  target?: FileComposerContext;
  change: () => void;
  cancel: () => void;
}

function transferFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files);
  return files.length ? files : Array.from(data.items)
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/** Owns native picker callbacks independently of the mounted editor or active session. */
export class FileInputs {
  private readonly options: FileInputOptions;
  private readonly consumed = new WeakSet<object>();
  private picker?: Picker;
  private disposed = false;

  constructor(options: FileInputOptions) {
    this.options = options;
    options.signal.addEventListener('abort', this.dispose, { once: true });
    if (options.signal.aborted) this.dispose();
  }

  private available(target: FileComposerContext): boolean {
    return !this.disposed && !this.options.signal.aborted && this.options.enabled &&
      !target.disabled && target.operation === 'prompt' && target.draft.purpose.kind === target.operation &&
      !target.draft.getSnapshot().pending;
  }

  private receive(files: readonly File[], target: FileComposerContext): void {
    if (files.length && this.available(target)) this.options.uploads.receive(files, target);
  }

  private close(picker: Picker): void {
    const input = picker.input;
    picker.input = undefined;
    picker.target = undefined;
    if (this.picker === picker) this.picker = undefined;
    if (!input) return;
    input.removeEventListener('change', picker.change);
    input.removeEventListener('cancel', picker.cancel);
    try { input.value = ''; }
    catch (error) { this.options.report(error); }
  }

  pick(target: FileComposerContext): void {
    try {
      if (!this.available(target)) return;
      if (this.picker) this.close(this.picker);
      const input = this.options.page?.createElement('input');
      if (!input) throw new Error('File selection requires a browser document.');
      const picker: Picker = {
        input, target: Object.freeze({ draft: target.draft, operation: target.operation, disabled: target.disabled }),
        change: () => {
          if (!picker.input || !picker.target) return;
          try {
            const captured = picker.target;
            const files = Array.from(picker.input.files ?? []);
            this.close(picker);
            this.receive(files, captured);
          } catch (error) {
            this.close(picker);
            this.options.report(error);
          }
        },
        cancel: () => this.close(picker),
      };
      this.picker = picker;
      input.type = 'file';
      input.multiple = true;
      input.addEventListener('change', picker.change);
      input.addEventListener('cancel', picker.cancel);
      // No await or render: the native dialog opens in the button's user-activation stack.
      input.click();
    } catch (error) {
      if (this.picker) this.close(this.picker);
      this.options.report(error);
    }
  }

  paste(event: ClipboardEvent<HTMLDivElement>, target: FileComposerContext): void {
    if (this.disposed || event.defaultPrevented || this.consumed.has(event.nativeEvent)) return;
    try {
      const files = transferFiles(event.clipboardData);
      if (!files.length) return;
      this.consumed.add(event.nativeEvent);
      // Mixed clipboard text/HTML still belongs to the browser's existing textarea insertion.
      if (!event.clipboardData.getData('text/plain') && !event.clipboardData.getData('text/html')) event.preventDefault();
      this.receive(files, target);
    } catch (error) { this.options.report(error); }
  }

  drop(event: DragEvent<HTMLDivElement>, target: FileComposerContext): void {
    if (this.disposed || event.defaultPrevented || this.consumed.has(event.nativeEvent)) return;
    try {
      const files = transferFiles(event.dataTransfer);
      if (!files.length) return;
      this.consumed.add(event.nativeEvent);
      event.preventDefault();
      this.receive(files, target);
    } catch (error) { this.options.report(error); }
  }

  dragOver(event: DragEvent<HTMLDivElement>, target: FileComposerContext): void {
    if (this.disposed || event.defaultPrevented) return;
    try {
      if (!Array.from(event.dataTransfer.types).includes('Files') &&
          !Array.from(event.dataTransfer.items).some(item => item.kind === 'file')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = this.available(target) ? 'copy' : 'none';
    } catch (error) { this.options.report(error); }
  }

  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.options.signal.removeEventListener('abort', this.dispose);
    if (this.picker) this.close(this.picker);
  };
}
