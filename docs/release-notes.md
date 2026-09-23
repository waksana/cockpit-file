# Cockpit File 0.2.1 (source preparation)

Prepare a fresh immutable patch package for the file-size labels merged in
[PR #31](https://github.com/waksana/cockpit-file/pull/31); do not replace 0.2.0 bytes.
Known sizes appear in parentheses after file names in draft/message attachments,
managed Markdown references and detail titles. Empty files show `(0 B)`; unknown sizes stay absent. Existing upload/HEAD
metadata supplies sizes without extra body downloads or duplicate size rows.

The minimum paired host remains **Cockpit 0.3.0**,
with the unchanged SDK pin `0fa433d99c053df2caf80770f0f8762b9ed7002e`.
Backend behavior, module configuration and persisted draft/file data are unchanged;
no migration is required. This source preparation does not publish a tag or Release.
An authorized install can select this package for the next normal start without
changing the running instance; installed/selected is not active deployment.

# Cockpit File 0.2.0

Source preparation, not a published release or deployment. Minimum paired host:
**Cockpit 0.3.0**. The immutable SDK foundation is
`0fa433d99c053df2caf80770f0f8762b9ed7002e` (module-api/protocol 0.3.0).
This reachable foundation provides the contracts and shared components; final
host application delivery remains a coordinated integration step.

The existing input/upload/draft/probe services are wired together in one shared
module with an activation-owned native `beforeunload` safeguard. Unfinished work
in hidden drafts is included; ready persisted attachments alone are not. Cancelling a
leave confirmation does not mutate resources. Browser restrictions still apply;
confirming navigation does not transfer uploads or promise resumability.

Manifest and package metadata now use the fresh feature version 0.2.0.
The existing draft schema and persisted encoding are unchanged; there is no data
migration or automatic replay. Pair the host and module.
Final archival packaging requires a clean committed source and matching build
receipt; no commit, tag, Release, installation or production action is implied.

# Cockpit File 0.1.9 (source preparation)

Assign a fresh immutable package version to the merged shared-UI changes rather
than replacing installed 0.1.8 bytes. Manifest and package metadata agree.
The supporting host pin remains `9fd5204bda99a8bd65b2c5ef152cc47ce87837d5`;
`uiSurfaceVersion: 1` remains required. No file business behavior, tag, Release,
production installation or restart is introduced by this version preparation.
Contributor guidance now explains when changed package bytes require a new version.

# Cockpit File 0.1.8 (source preparation)

Preview dialogs use native initial focus without redundant React autofocus.
Retry only moves focus when replacing its own focused action; native modal
isolation, Escape and return remain unchanged. The two scoped retry continuity
paths remain intentional.

The unreleased shared UI migration reuses public surfaces, headings and action
rows and requires `context.uiSurfaceVersion === 1` alongside UI v1 before
registration. The exact paired host source is
`9fd5204bda99a8bd65b2c5ef152cc47ce87837d5` (exported SDK 0.2.6), not the
historical Cockpit 0.2.3 baseline. Native media sizing and lifecycle are unchanged.
No historical Release gains these capabilities retroactively; no tag, publication
or deployment is implied by this source change.

# Cockpit File 0.1.7

Frontend plugin migration paired with Cockpit **0.2.3**, Web API v2 and Module UI v1.
Module manifest/backend API remain v1. Assets are available only after this immutable
tag's Release workflow succeeds; publication is not installation or restart.

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

Exact Cockpit 0.2.3 release source and exported types are pinned in `tooling/host-sdk.json`.
Old frontend slots are intentionally not supported by the new host: upgrade host
and modules together using the existing authorized cold-start procedure.

## Known limitation

Text/code previews and source-line navigation such as `#L128` are not implemented.
These types offer file details and original download, not a fabricated code preview.
HTML/PDF remain download-only; SVG preview stays in image mode with restricted headers.

This change does not fix HTTP/1.1 multi-tab connection starvation or change the
existing hidden-page HEAD deadline. Queued requests can still exceed five seconds;
their failure remains an unfinished status check rather than proof of
a missing file. No native history backfill or server data migration is performed;
the file schema restores its own legacy browser draft attachments.

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
