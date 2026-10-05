import sanitizeHtml from 'sanitize-html';
import { parseMarkdown } from './markdown.ts';
import { toHast } from 'mdast-util-to-hast';
import { toHtml } from 'hast-util-to-html';
import { FileStorageError } from './storage.ts';
import { DOCUMENT_SOURCES, type DocumentKind } from '../shared/documents.ts';

function renderMarkdown(content: string): string {
  const root = parseMarkdown(content);
  const pending = root.children.map(node => ({ node, depth: 1 }));
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > 50_000 || depth > 100) throw new FileStorageError('LIMIT_EXCEEDED', 'Markdown is too complex to preview; download the original.');
    if ('children' in node) {
      for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
    }
  }
  return toHtml(toHast(root));
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function link(value: string, host: string): boolean {
  if (!/^https?:\/\//i.test(value) || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const current = new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, '');
    return !url.username && !url.password && hostname !== current && hostname.includes('.')
      && !/^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hostname)
      && !/\.(?:localhost|local|internal)$/.test(hostname);
  } catch {
    return false;
  }
}

export function renderDocument(content: string, kind: DocumentKind, name: string, host: string): string {
  const html = kind === 'markdown' ? renderMarkdown(content) : content;
  const clean = sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'style', 'details', 'summary', 'input'],
    allowedAttributes: {
      '*': ['id', 'class', 'style', 'title', 'lang', 'dir'],
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'],
      ol: ['start'], li: ['value'], input: ['type', 'checked', 'disabled'],
    },
    allowedSchemes: ['http', 'https'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    allowVulnerableTags: true,
    nestingLimit: 100,
    transformTags: {
      a: (_tag, attributes): sanitizeHtml.Tag => {
        const href = attributes.href;
        if (!href || !link(href, host)) return { tagName: 'span', attribs: { title: 'Link blocked in single-file preview' } };
        return { tagName: 'a', attribs: { href, target: '_blank', rel: 'noopener noreferrer' } };
      },
      img: (_tag, attributes) => {
        if (!/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(attributes.src ?? '')) {
          return { tagName: 'span', attribs: {}, text: `[Image unavailable: ${attributes.alt || 'external or relative resource blocked'}]` };
        }
        return { tagName: 'img', attribs: attributes };
      },
      input: (_tag, attributes) => ({ tagName: 'input', attribs: {
        type: 'checkbox', disabled: '', ...('checked' in attributes ? { checked: '' } : {}),
      } }),
    },
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escape(DOCUMENT_SOURCES)}"><meta name="referrer" content="no-referrer"><title>${escape(name)}</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:24px;overflow-wrap:anywhere;color:#202124;background:#fff}img{max-width:100%;height:auto}pre{overflow:auto;padding:1rem;background:#f3f4f6}code{font-family:monospace}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:.4rem}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:1rem}</style></head><body>${clean}</body></html>`;
}
