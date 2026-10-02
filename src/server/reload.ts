import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleHostApi, NativeChatEvent } from '@waksana/cockpit-module-sdk/backend';
import { decodeMessageReference } from '../shared/files.ts';
import { containsFileReference } from './markdown.ts';
import { FileStorageError } from './storage.ts';

const fail = (code: string, message: string) => new FileStorageError(code, message);

/** Only a persisted native assistant message can authorize a client-requested source. */
export async function reloadSource(host: ModuleHostApi, encoded: string, signal: AbortSignal) {
  const { origin, reference } = decodeMessageReference(encoded);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(origin.sessionId)) throw fail('INVALID_INPUT', 'Invalid native session identity');
  let cursor: string | undefined;
  let matched: NativeChatEvent | undefined;
  let path: string | undefined;
  let bytes = 0;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
    signal.throwIfAborted();
    const page = await host.call('session/chat', {
      sessionId: origin.sessionId, source: 'persisted', direction: 'backward',
      max: 64, waitMs: 0, bootstrap: false, ...(cursor ? { cursor } : {}),
    });
    signal.throwIfAborted();
    if (page.cursorStatus !== 'ok' || page.sessionId !== origin.sessionId
        || page.source !== 'persisted' || page.direction !== 'backward') {
      throw fail('HISTORY_UNCONFIRMED', 'Native history identity or cursor could not be confirmed');
    }
    // Native pages retain append order, even when paging backward.
    for (const event of [...page.events].reverse()) {
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (bytes > 8 * 1024 * 1024) throw fail('HISTORY_LIMIT', 'Reference verification exceeded its bounded history budget');
      if (!matched && event.type === 'assistant.message' && event.data.messageId === origin.messageId && !event.ephemeral) {
        if (typeof event.data.content !== 'string') throw fail('INVALID_SOURCE', 'Native message has no complete text');
        if (Buffer.byteLength(event.data.content) > 256 * 1024) {
          throw fail('HISTORY_LIMIT', 'Native message exceeds the 256 KiB Markdown verification limit');
        }
        if (!containsFileReference(event.data.content, reference)) {
          throw fail('REFERENCE_MISMATCH', 'The exact local reference is not present in the native assistant message');
        }
        matched = event;
        path = /^file:/i.test(reference) ? fileURLToPath(new URL(reference))
          : decodeURIComponent(reference.split(/[?#]/, 1)[0]!.replace(/%(?![\da-fA-F]{2})/g, '%25'));
        if (/[\0-\x1f\x7f]/.test(path)) throw fail('INVALID_SOURCE', 'Invalid native reference path');
        if (isAbsolute(path)) return { origin, reference, path: resolve(path) };
        if (event.agentId || event.parentToolCallId || event.data.agentId || event.data.parentToolCallId) {
          throw fail('CONTEXT_UNAVAILABLE', 'A child message needs an absolute path; its historical working directory is unconfirmed');
        }
        if (normalize(path).startsWith(`files${sep}`)) {
          throw fail('CONTEXT_UNAVAILABLE', 'Historical SDK workspace is unavailable; share an absolute path in a new message');
        }
      }
      if (matched && path && !event.agentId && !event.parentToolCallId && !event.data.agentId && !event.data.parentToolCallId) {
        const context = event.data.context;
        const cwd = event.type === 'session.context_changed' ? event.data.cwd
          : event.type === 'session.start' && context && typeof context === 'object' && 'cwd' in context ? context.cwd : undefined;
        if (event.type === 'session.context_changed' || event.type === 'session.start') {
          if (typeof cwd !== 'string' || !isAbsolute(cwd) || /[\0-\x1f\x7f]/.test(cwd)) {
            throw fail('CONTEXT_UNAVAILABLE', 'Native historical working directory could not be confirmed');
          }
          return { origin, reference, path: resolve(cwd, path) };
        }
      }
    }
    if (!page.hasMore) throw fail(matched ? 'CONTEXT_UNAVAILABLE' : 'REFERENCE_MISMATCH',
      matched ? 'Native historical working directory is unavailable' : 'Native assistant message was not found');
    if (!page.cursor || seen.has(page.cursor)) throw fail('HISTORY_UNCONFIRMED', 'Native history cursor did not advance');
    cursor = page.cursor;
    seen.add(cursor);
  }
  throw fail('HISTORY_LIMIT', 'Reference verification exceeded 2048 native events; no file was synchronized');
}
