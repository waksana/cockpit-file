# Cockpit File 0.1.2

Unreleased fixed-layout file-card update for Cockpit Module API v1.

- Keep draft/message cards at 280 x 72px at the default font size across loading, ready, submission and error states.
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

Discard eligibility is local to the originating browser activation, not a global reference count.
A duplicated tab can restore the same attachment path and submit it while the original tab still
considers it removable. Removing it in the original tab can delete bytes needed by the duplicate.
Do not use removal as a safe cleanup action for attachments shared across duplicated drafts.
This known issue is deferred to [waksana/cockpit-file#6](https://github.com/waksana/cockpit-file/issues/6);
this release does not add cross-tab reference coordination, content deduplication or garbage collection.
