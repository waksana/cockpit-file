export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
export const MAX_RENDERED_BYTES = 16 * 1024 * 1024;
export type DocumentKind = 'markdown' | 'html';
export const DOCUMENT_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';
export const DOCUMENT_SOURCES = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
export const DOCUMENT_CSP = `sandbox ${DOCUMENT_SANDBOX}; ${DOCUMENT_SOURCES}; frame-ancestors 'self'`;

export function documentKind(file: { name: string; mime: string }): DocumentKind | undefined {
  if (file.mime !== 'application/octet-stream') return;
  if (/\.(?:md|markdown)$/i.test(file.name)) return 'markdown';
  if (/\.html?$/i.test(file.name)) return 'html';
}
