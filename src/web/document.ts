import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';
import { fileRequestPath } from '../shared/files.ts';
import { MAX_RENDERED_BYTES } from '../shared/documents.ts';

export async function loadDocument(
  context: Pick<ModuleFrontendContext, 'request' | 'apiBase'>, url: string, signal: AbortSignal,
): Promise<string> {
  const response = await context.request(`${fileRequestPath(context.apiBase, url)}?preview=1`, { signal });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('text/html') ||
      !['markdown', 'html'].includes(response.headers.get('x-file-preview') ?? '')) {
    await response.body?.cancel();
    throw new Error(response.status === 413 ? '文档过大、过于复杂或渲染超时，无法预览；原件仍可下载。'
      : response.status === 422 ? '此文档无法预览（仅支持 UTF-8 文本），原件仍可下载。'
        : `文档预览请求失败（HTTP ${response.status}），原件仍可下载。`);
  }
  if (!response.body) throw new Error('文档预览响应没有正文。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RENDERED_BYTES) throw new Error('渲染后的文档过大，原件仍可下载。');
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
