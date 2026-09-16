import type { MessageOrigin } from '@cockpit/module-api';

const opaqueId = /^f_[a-f0-9]{64}$/;
const storedBody = /^body(?:\.[a-z0-9]{1,16})?$/;
const controls = /[\u0000-\u001f\u007f]/;
const maxReferenceLength = 16_384;

export function isFileId(value: string): boolean {
  return opaqueId.test(value);
}

function apiRoot(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, '');
  if (!base || base.startsWith('//') || /[?#\\]/.test(base) || controls.test(base) || base !== base.trim()) {
    throw new Error('Invalid file API base');
  }
  if (base.startsWith('/')) return base;
  try {
    const url = new URL(base);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      throw new Error('Invalid file API base');
    }
    return url.href.replace(/\/+$/, '');
  } catch {
    throw new Error('Invalid file API base');
  }
}

export function managedFileUrl(apiBase: string, fileId: string, bodyName: string): string {
  if (!isFileId(fileId) || !storedBody.test(bodyName)) throw new Error('Invalid managed file identity or body name');
  return `${apiRoot(apiBase)}/files/${encodeURIComponent(fileId)}/${bodyName}`;
}

export function nativeFileUrl(path: string, prefix: string, apiBase: string): string | null {
  if (!prefix.startsWith('/') || prefix.startsWith('//') || !prefix.endsWith('/') ||
      /[\\]/.test(prefix) || controls.test(prefix) || !path.startsWith(prefix) ||
      /[\\]/.test(path) || controls.test(path)) return null;
  const segments = path.slice(prefix.length).split('/');
  const fileId = segments[0];
  if (segments.length !== 3 || !fileId || !isFileId(fileId) || segments[1] !== 'ready' ||
      !storedBody.test(segments[2] ?? '')) return null;
  if (prefix.split('/').some(part => part === '.' || part === '..')) return null;
  return managedFileUrl(apiBase, fileId, segments[2]!);
}

export const toFileUrl = nativeFileUrl;

export function toNativePath(url: string, prefix: string, apiBase: string): string {
  const relative = fileRequestPath(apiBase, url);
  const match = /^\/files\/(f_[a-f0-9]{64})\/(body(?:\.[a-z0-9]{1,16})?)$/.exec(relative);
  if (!match) throw new Error('URL is not a canonical managed original');
  const path = `${prefix}${match[1]}/ready/${match[2]}`;
  if (nativeFileUrl(path, prefix, apiBase) !== url) throw new Error('Invalid native file prefix or noncanonical URL');
  return path;
}

export function isLocalFileReference(reference: string): boolean {
  if (!reference || reference.length > maxReferenceLength || reference !== reference.trim() ||
      controls.test(reference) || reference.startsWith('//') || reference.startsWith('\\') ||
      reference.startsWith('#') || reference.startsWith('?')) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(reference)?.[1];
  if (!scheme) return true;
  if (scheme.toLowerCase() !== 'file') return false;
  try {
    const url = new URL(reference);
    return (url.hostname === '' || url.hostname === 'localhost') && url.pathname.startsWith('/');
  } catch {
    return false;
  }
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_048 && !controls.test(value);
}

export function encodeMessageReference(origin: MessageOrigin, reference: string): string {
  if (!validIdentity(origin.sessionId) || !validIdentity(origin.messageId) || !isLocalFileReference(reference)) {
    throw new Error('Invalid message file reference');
  }
  const json = JSON.stringify([origin.sessionId, origin.messageId, reference]);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeMessageReference(encoded: string): { origin: MessageOrigin; reference: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 131_072 || encoded.length % 4 === 1) {
    throw new Error('Invalid encoded message file reference');
  }
  try {
    const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Array.isArray(value) || value.length !== 3 ||
        !validIdentity(value[0]) || !validIdentity(value[1]) || typeof value[2] !== 'string') {
      throw new Error('Invalid message file identity');
    }
    const origin: MessageOrigin = {
      sessionId: value[0],
      messageId: value[1],
    };
    const reference = value[2];
    if (encodeMessageReference(origin, reference) !== encoded) throw new Error('Noncanonical reference');
    return { origin, reference };
  } catch {
    throw new Error('Invalid encoded message file reference');
  }
}

export function messageFileUrl(apiBase: string, origin: MessageOrigin, reference: string): string {
  return `${apiRoot(apiBase)}/messages/${encodeMessageReference(origin, reference)}`;
}

export function fileRequestPath(apiBase: string, url: string): string {
  const base = apiRoot(apiBase);
  if (!url.startsWith(`${base}/files/`) && !url.startsWith(`${base}/messages/`)) {
    throw new Error('File URL is outside this module');
  }
  return url.slice(base.length);
}
