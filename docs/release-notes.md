# Cockpit File 0.1.4

Preview interaction update for Cockpit Module API v1.

- The card body, filename and thumbnail share one accessible preview target; download, remove and retry stay independent.
- Image/media titles open the actual preview, not a separate text-only dialog. Non-previewable files retain full details.
- Keep the focus indicator inside the full tile after closing a dialog, without changing card/input geometry or removing keyboard focus.
- A late close from an obsolete resource cannot dismiss a newer preview; image metadata arriving in an open details dialog upgrades it to preview.

- Resolve `files/...` against only the project cwd and SDK-provided session workspace.
  Capture a unique source; reject ambiguity instead of guessing, searching disks or prompting the Agent.
- Keep the session/message/raw-reference URL unchanged regardless of which source directory supplied the bytes.
- Requires the SDK workspace observation field in waksana/cockpit#15; absent early context is not treated as proof that no native workspace exists.
- Recognize newly stored SVG bytes and preview them through the existing image-card path.
- Keep SVG in image mode rather than injecting markup, with sandboxed resource headers,
  blocked external resources/scripts and permitted inline drawing styles.
- Preserve original downloads and existing snapshot MIME; no historical capture or data migration.
- The preview retry action rechecks the stored snapshot only. It does not copy a source again
  for an old missing/failed reference; a new live message can initiate a new capture.

- Keep draft/message cards at 280 x 72px at the default font size across loading, ready, submission and error states.
- Narrow screens share a viewport width cap (240 x 72px at a 320px viewport) without changing the host's message arrangement.
- Use two bounded information lines, a reserved activity track and fixed right-side icon actions.
- Add keyboard/touch-accessible full filename and error details; preserve bounded extensions while truncating long names.
- Fit whole images inside 48px thumbnails and refine the centered attachment icon's stroke and bounds.
- No host layout, queue-preview, upload protocol, reference/deletion or lifecycle changes.

- Chat uploads, paste/drop attachments, native attachment submission, previews and downloads.
- Successful uploads persist immediately in the host draft; refresh discards unfinished selections.
- Native blob cards use available inline bytes or show an explicit unavailable state without historical recovery.
- Draft and message attachments share compact thumbnail cards with item-local upload feedback.
- The attachment action follows the host's borderless icon-button style. Normal upload blockers
  no longer need a separate host notice or a duplicate native-attachment accordion.
- Upload, selection, removal and retry controls are disabled while awaiting the native send receipt;
  stale picker, paste and drop callbacks cannot bypass this state. Text remains editable.
- Explicitly removed, never-submitted uploads from the current page can be discarded asynchronously.
  Restored attachments and files already handed to native submission retain their originals.
- Best-effort incremental capture of new Markdown file references with immutable per-message originals.
- Five-second card loading budget; no historical backfill or content deduplication.
- Local trusted `.tgz` installation only. No global file-library management or remote installer.
- Requires the pinned Cockpit 0.2.0 host source in `tooling/host-sdk.json`; the already published
  Cockpit v0.1.0 service does not provide the required module API.
- Node 24.20.0 and Linux are the current runtime baseline. CI exercises Linux x64.
- Cockpit manages only host/module data; native Copilot sessions and authentication
  keep their own default directory and configuration without migration.

The module runs as trusted host-process code and may capture local files readable by the service user.
Do not expose module routes without the host's authenticated access boundary.

## Known limitation

The preview change contains the focus ring within the tile; it does not remove
normal keyboard focus. The separately reported horizontal line after mouse-close
was not reliably reproduced, so this release does not claim a confirmed fix for
every such artifact. The broader interaction/structure review is tracked in
[waksana/cockpit#17](https://github.com/waksana/cockpit/issues/17).

Discard eligibility is local to the originating browser activation, not a global reference count.
A duplicated tab can restore the same attachment path and submit it while the original tab still
considers it removable. Removing it in the original tab can delete bytes needed by the duplicate.
Do not use removal as a safe cleanup action for attachments shared across duplicated drafts.
This known issue is deferred to [waksana/cockpit-file#6](https://github.com/waksana/cockpit-file/issues/6);
this release does not add cross-tab reference coordination, content deduplication or garbage collection.
