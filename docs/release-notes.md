# Cockpit File 0.1.0

Initial local file module for Cockpit Module API v1.

- Chat uploads, paste/drop attachments, native attachment submission, previews and downloads.
- Best-effort incremental capture of new Markdown file references with immutable per-message originals.
- Five-second card loading budget; no historical backfill or content deduplication.
- Local trusted `.tgz` installation only. No global file-library management or remote installer.
- Requires the pinned Cockpit 0.2.0 host source in `tooling/host-sdk.json`; the already published
  Cockpit v0.1.0 service does not provide the required module API.
- Node 24.20.0 and Linux are the current runtime baseline. CI exercises Linux x64.

The module runs as trusted host-process code and may capture local files readable by the service user.
Do not expose module routes without the host's authenticated access boundary.
