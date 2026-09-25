import type { NativeAttachmentDescriptor } from '@waksana/cockpit-module-sdk';

export type NativeBlob = Extract<NativeAttachmentDescriptor, { type: 'blob' }>;

export function unavailableBlobReason(attachment: NativeBlob): string | undefined {
  if (attachment.omittedReason === 'too_large') return '原生附件数据超过返回大小限制';
  if (attachment.omittedReason) return '原生附件资源不可用';
  if (attachment.data === undefined) return '原生未提供附件数据';
  return undefined;
}

export function decodeNativeBlob(attachment: NativeBlob, maxBytes: number): Blob {
  const unavailable = unavailableBlobReason(attachment);
  if (unavailable || attachment.data === undefined) throw new Error(unavailable);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid blob size limit');
  const data = attachment.data;
  if (data.length > Math.ceil(maxBytes / 3) * 4) throw new Error('原生附件超过文件大小限制');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('原生附件的 Base64 数据无效');
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  // Keep quartet boundaries without allocating a second full decoded string.
  for (let offset = 0; offset < data.length; offset += 65_536) {
    const decoded = atob(data.slice(offset, offset + 65_536));
    size += decoded.length;
    if (size > maxBytes) throw new Error('原生附件超过文件大小限制');
    parts.push(Uint8Array.from(decoded, character => character.charCodeAt(0)));
  }
  return new Blob(parts, { type: attachment.mimeType });
}
