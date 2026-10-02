import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

export function containsFileReference(content: string, reference: string): boolean {
  const root = fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const pending = [...root.children];
  while (pending.length) {
    const node = pending.pop()!;
    if ((node.type === 'link' || node.type === 'image') && node.url === reference) return true;
    if ('children' in node) pending.push(...node.children);
  }
  return false;
}
