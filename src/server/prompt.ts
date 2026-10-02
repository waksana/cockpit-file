import type { ModuleIntentMiddleware } from '@waksana/cockpit-module-sdk/backend';
import { FileStorageError, type FileStorage, type PromptRecord } from './storage.ts';

export function promptMiddleware(storage: FileStorage, stopping: AbortSignal): ModuleIntentMiddleware<'prompt'> {
  return async (invocation, next) => {
    const signal = AbortSignal.any([invocation.signal, stopping]);
    const check = () => {
      if (signal.aborted) throw new FileStorageError('ABORTED', 'Prompt attachment preparation was cancelled');
    };
    check();
    const attachments = invocation.body.attachments;
    if (!attachments?.some(item => item.type === 'file')) { await next(); return; }
    const external: PromptRecord['files'] = [];
    for (const [index, item] of attachments.entries()) {
      check();
      if (item.type === 'file' && !await storage.managedPath(item.path)) external.push({ index, source: item.path });
    }
    check();
    if (!external.length) { await next(); return; }
    const record: PromptRecord = {
      version: 1, invocationId: invocation.invocationId, sessionId: invocation.body.sessionId,
      captureKey: JSON.stringify(['prompt', invocation.body.sessionId, invocation.invocationId]),
      state: 'preparing', files: external,
    };
    await storage.recordPrompt(record, true);
    const enhanced = [...attachments];
    try {
      for (const entry of external) {
        check();
        const file = await storage.capture(record.captureKey, String(entry.index), entry.source, signal);
        entry.fileId = file.id;
        const original = attachments[entry.index]!;
        if (original.type !== 'file') throw new Error('Prompt attachment identity changed during preparation');
        enhanced[entry.index] = { ...original, path: file.path };
        await storage.recordPrompt(record);
      }
      check();
      // Durable uncertainty precedes next: a thrown result cannot prove no native effect.
      record.state = 'sending_unknown';
      await storage.recordPrompt(record);
      check();
    } catch (error) {
      record.state = 'not_sent';
      record.error = { code: error instanceof FileStorageError ? error.code : 'PREPARATION_FAILED',
        message: 'Attachment preparation failed; no downstream prompt was called' };
      try { await storage.recordPrompt(record); }
      catch (recordError) { throw new AggregateError([error, recordError], 'Prompt preparation and failure persistence failed'); }
      throw error;
    }
    // Never clean up published bodies here: they may already be referenced by native history.
    const receipt = await next({ attachments: enhanced });
    record.state = 'returned';
    record.receipt = receipt;
    await storage.recordPrompt(record);
  };
}
