# Cockpit File 0.1.6

Compact file display update for Cockpit v0.2.0 / Module API v1 / Module UI v1.
Assets become available after the immutable-tag Release workflow succeeds.

## Changes since 0.1.5

- Draft and native attachments use single rows, without thumbnails or card borders.
  The public control height, status column and two independent action slots stay
  stable during loading, submission and failure; long row names are truncated.
- Markdown links and images use real inline links with inherited typography,
  no vertical padding or fixed height, and naturally wrappable full names.
  A reference in its own paragraph remains the same inline component.
  Presentation follows the native attachment/link/image kind, not guessed line breaks.
- Inline references expose preview/details on ordinary activation and preserve
  modified-click link behavior. Full errors, download and retry live in the dialog,
  not in a growing inline toolbar.
- HEAD checks stop at metadata readiness. Media bytes load only when explicitly
  opened; each preview attempt has its own five-second loading budget and cleanup.
  Closing and retrying never recapture a source or re-upload an attachment.
- Structured check errors distinguish timeout, network and HTTP failures.
  A timeout does not prove that the file is missing; failed media previews preserve
  an already available original download.
- Keep public Lucide UI, body-portaled native dialogs, stable return focus and
  stale event isolation. Upload/pending/ACK, storage, reference identity and native
  session behavior do not change.
- Keep the immutable SDK pin `79e2946bab382ff68e3cf2a84d42827f011cbe53`.
  No new host API, private DOM dependency, runtime icon service or extra React is added.

## Known limitation

Text/code previews and source-line navigation such as `#L128` are not implemented.
These types offer file details and original download, not a fabricated code preview.
HTML/PDF remain download-only; SVG preview stays in image mode with restricted headers.

This change does not fix HTTP/1.1 multi-tab connection starvation or change the
existing hidden-page HEAD deadline. Queued requests can still exceed five seconds;
their failure is now described as an unfinished status check rather than proof of
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
