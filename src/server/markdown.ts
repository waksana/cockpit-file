import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
export function parseMarkdown(content: string) {
  return fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

export function containsFileReference(content: string, reference: string): boolean {
  const root = parseMarkdown(content);
  const pending = [...root.children].reverse();
  const references: string[] = [];
  const definitions = new Map<string, string>();
  while (pending.length) {
    const node = pending.pop()!;
    if ((node.type === 'link' || node.type === 'image') && node.url === reference) return true;
    if (node.type === 'definition' && !definitions.has(node.identifier.toUpperCase())) {
      definitions.set(node.identifier.toUpperCase(), node.url);
    }
    if (node.type === 'linkReference' || node.type === 'imageReference') references.push(node.identifier.toUpperCase());
    if ('children' in node) pending.push(...[...node.children].reverse());
  }
  return references.some(id => definitions.get(id) === reference);
}
