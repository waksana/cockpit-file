# Single-file document previews

Files renders managed `.md` / `.markdown` files and static `.html` / `.htm`
documents in its existing preview dialog. The dialog includes **Open in new tab**
and the unchanged original download action. Modified clicks on a ready document
reference open the isolated preview URL rather than downloading its source.
File names used for recognition come from stored metadata, not the chat link label.
Recognized binary media retain their existing image/audio/video previews.

This applies to saved uploads, managed native file attachments and captured
message references, including existing snapshots. Native in-memory blob attachments
retain their existing media/download behavior; they are not silently uploaded.
No storage migration, recapture, native session load or Host change is required.

## Supported content

Markdown supports CommonMark/GFM paragraphs, headings, emphasis, lists, tables,
task lists, fenced code and links. Code is escaped, not executed; no syntax
highlighting, Mermaid, math renderer or raw-HTML interpretation is added.
HTML keeps supported static markup and inline CSS, but is not a full browser
application renderer.

Preview input must be UTF-8 text without NUL bytes, at most **2 MiB**.
Empty documents are valid. Invalid encoding, oversized files and failed reads
produce explicit errors while preserving download. Recognition by extension is a
preview choice, not proof of safe content: every rendered document is sanitized.
Original MIME metadata, storage identity, hash, source bytes and attachment paths
are unchanged. Other formats continue to use their existing behavior.

Parsing/sanitizing runs in a terminable worker, not on the Host event loop.
Each worker has a three-second deadline and V8 heap limits (64 MiB old generation,
16 MiB young generation); existing work limits bound concurrent workers. Rendered
output is limited to 16 MiB, and Markdown ASTs to 50,000 nodes / 100 levels.
Excessive complexity or memory use returns a preview error, not a Host stall.
Cancellation and module shutdown terminate workers before releasing their work slots.

Only embedded base64 PNG/JPEG/GIF/WebP/AVIF images are displayed. Relative and
external image URLs become visible unavailable-image markers. External styles,
fonts, scripts and all other network resources are blocked. A notice outside the
document explains that missing styles/resources may change the layout.
There is no directory scan, local resource resolver, resource upload bundle,
network proxy or website hosting service.

## Isolation and links

The File backend uses the existing authenticated, digest-scoped module routes:

- Normal `GET` / `HEAD` still serve original metadata/bytes. A ready document has
  an `X-File-Preview: markdown|html` hint without reading its body.
- `?preview=1` reads only the already-managed snapshot and returns a sanitized
  HTML representation. Ranges do not apply to that representation.
- `?download=1` always wins, even together with `preview=1`, and returns the
  unchanged original as an attachment.

Document responses are `no-store`, `nosniff`, `no-referrer` and carry a CSP
`sandbox` without `allow-same-origin`, `allow-scripts`, `allow-forms` or top-level
navigation permission. The dialog fetches the representation through
`context.request` and places it in a similarly sandboxed `srcdoc` iframe, never
in Host DOM. The representation also contains a restrictive CSP meta policy:
no resource loads except inline CSS and data images. New-tab viewing uses the
authenticated HTTP representation with the response-level sandbox; it does not
open an unsandboxed HTML blob.

Scripts, handlers, frames, objects, forms, refresh directives and base elements
are removed. File content cannot read Host cookies/storage/DOM, use its APIs or
obtain its origin privileges. Trusted File module code continues to run under
the normal Host module trust contract; this is content isolation, not a module
process sandbox.

Only explicit absolute HTTP(S) hyperlinks to external hosts survive. Relative,
fragment, local-file and executable links are disabled; fragments are deliberately
not resolved against the inherited `srcdoc` Host base. URLs naming the current
request hostname, credentials, loopback/private IPv4 addresses and local names
are blocked. External links have `_blank` and `noopener noreferrer`; opening a
new tab requires the user's click. The sandbox allows that new external tab to
leave the sandbox so ordinary destination websites can work, without an opener.
This is not a remote-site reputation checker: DNS aliases, redirects and content
on an explicitly visited external website are outside the single-file preview.

Preview failures do not mark an available original as missing or trigger capture.
The existing five-second dialog loading deadline, retry, close, keyboard focus
and module-unload cleanup remain in effect. Closing aborts document fetching;
opening a preview never submits an attachment or sends a native message.
