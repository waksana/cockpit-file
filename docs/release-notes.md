# Cockpit File 0.1.7 (development)

Frontend plugin migration requiring paired Cockpit Web API v2 and Module UI v1.
Module manifest/backend API remain v1. This source is not a published or installed release.

## Changes since 0.1.6

- Register shared upload/probe services and a prompt-only draft attachment schema.
  Validation, native projection, persistence/legacy restore and ACK cleanup belong
  to the module; the base draft has no attachment field or missing-file fallback.
- Enhance Composer with the entire ready+pending file list and native historical
  Attachment components with file presentation. No host-built draft attachment group,
  dedicated list boundary or attachment-list hiding flag.
- Keep a separate Markdown link/image renderer; native attachments no longer pass through it.
- Own picker/paste/drop capture and cleanup in a registered file service and actual
  editor-row middleware. The host has no file dispatcher or handoff contract.
  Captured draft state outlives component/session navigation.
- Native questions use separate request-keyed drafts; prompt text/files stay cached
  and return when the decision ends. File UI is absent on inapplicable draft purposes.
- Middleware adds no HTML wrapper or empty placeholder. Preserve the existing
  compact 40px/44px rows, true inline references, independent actions and body portals.
- HTTP behavior, capture/storage, native attachment delivery and preview deadlines
  are unchanged. No private DOM access, second React runtime or backend feature is added.

Exact host source and exported types are pinned in `tooling/host-sdk.json`.
Old frontend slots are intentionally not supported by the new host: upgrade host
and modules together using the existing authorized cold-start procedure.

## Known limitation

Text/code previews and source-line navigation such as `#L128` are not implemented.
These types offer file details and original download, not a fabricated code preview.
HTML/PDF remain download-only; SVG preview stays in image mode with restricted headers.

This change does not fix HTTP/1.1 multi-tab connection starvation or change the
existing hidden-page HEAD deadline. Queued requests can still exceed five seconds;
their failure remains an unfinished status check rather than proof of
a missing file. No history backfill or data migration is performed.

Discard eligibility is local to the originating browser activation, not a global
reference count. A duplicated tab can restore and submit the same attachment while
the originating tab still considers it removable. Removing it there can delete
bytes needed by the duplicate. This remains explicitly deferred to
[waksana/cockpit-file#6](https://github.com/waksana/cockpit-file/issues/6);
this release adds no cross-tab reference coordination, content deduplication or
garbage collection.

The module runs as trusted host-process code and may capture local files readable
by the service user. Keep module routes behind the host authentication boundary.
Publishing or merging this source does not install it or restart a service.
