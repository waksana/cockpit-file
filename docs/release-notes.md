# Cockpit File 0.1.1

Unreleased compact file-card update for Cockpit Module API v1.

- Chat uploads, paste/drop attachments, native attachment submission, previews and downloads.
- Successful uploads persist immediately in the host draft; refresh discards unfinished selections.
- Native blob cards use available inline bytes or show an explicit unavailable state without historical recovery.
- Draft and message attachments share compact thumbnail cards with item-local upload feedback.
- The attachment action follows the host's borderless icon-button style. Normal upload blockers
  no longer need a separate host notice or a duplicate native-attachment accordion.
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
