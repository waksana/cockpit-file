# Rolling releases and Milestones

This workflow replaces manual stable-version preparation and tag-push publication
starting with the PR introducing it. Historical tags and Releases remain unchanged;
no historical PR is backfilled. These are installable module archives, not npm packages.

## Rolling boundary and identity

Every actual PR merge into `main`, including docs and chores, triggers `Rolling`
(`.github/workflows/release.yml`) using the closed, merged PR event and its exact
`merge_commit_sha`. Closing without merging publishes nothing. There are no labels,
path filters or a shared concurrency queue that could discard consecutive merges.
Do not rename/reset this workflow: its `github.run_number` is the stable positive
sequence, including across reruns. Gaps are permitted; completion time is not order.
Consumers select the greatest compatible sequence, never the most recently completed
run. A failed attempt neither blocks later merges nor becomes a successful candidate.

Committed `package.json` and `cockpit.module.json` stay at `0.0.0-dev`. Ordinary builds
expose `dev+<shortSHA>` through the backend's `publicConfig.displayVersion` and
`dist/build-identity.json`. Release jobs build the exact clean merge commit and inject
`0.0.0-rolling.<sequence>` into a private archive staging copy, build receipt and runtime
identity. The immutable tag is `v0.0.0-rolling.<sequence>`. Nothing writes versions
back to `main`; the separately published SDK version and lock integrity are unchanged.

The reusable `CI / Required checks` workflow installs the locked registry SDK, runs
typecheck/tests/build, packages and verifies the original archive, then exercises it
through the pinned integration host. PR validation creates development artifacts,
not Releases. Rolling publication downloads the same run's checked artifact and
does not rebuild it. Build provenance requires clean committed source.

## Four verified assets

Each Rolling Release has exactly:

```text
cockpit-file-0.0.0-rolling.N.tgz
cockpit-file-0.0.0-rolling.N.tgz.sha256
cockpit-deployment.json
cockpit-deployment.json.sha256
```

The archive contains the module manifest, compiled `dist/`, LICENSE, build receipt
and root `cockpit-deployment.json`. The descriptor is byte-identical to its sidecar.
Both standalone checksum assets use SHA-256. The archive checksum is never embedded
in the descriptor: doing so would introduce self-reference. Checksums detect integrity
changes, not independent publisher signatures.

The format-2 descriptor declares channel `rolling`, repository, source SHA, tag,
version, sequence and archive name. `scripts/rolling-identity.mjs` derives the module
API range from the manifest and checks the actual frontend/draft/storage contracts.
File requires backend/module API 1, frontend API 2, UI/surface 1, composer input,
draft lifecycle and draft submission capabilities. It invokes no host intents.
Storage is ordinary file bodies with version-2 metadata, not SQLite: databases and
migrations are empty. This does not authorize deletion, recapture, migration or
weakening retention of existing snapshots and drafts. Changes to these contracts
must update their source-derived descriptor and tests; unknown compatibility fails.
No machine-local per-release compatibility catalog is maintained.

## Publication, failure and recovery

Publication verifies source, package/build versions, SDK identity, file inventory,
four assets, both checksums and embedded/sidecar equality. Tag creation is immutable.
A draft is created with the corresponding PR's full title and body plus deterministic
source and asset information. Each uploaded asset is downloaded and byte-checked.
Only a complete verified draft becomes a non-draft **prerelease** with
`make_latest=false`; Rolling never claims Latest. That publication atomically seals
the original four asset IDs, names, sizes and SHA-256 hashes in the release body.

All tag/release/asset mutations use one direct HTTPS attempt, without redirects or
automatic retries. A timeout, cancellation or malformed write acknowledgement means
the remote result is **unknown**, not absent. Stop and inspect authoritative tag,
release/draft IDs and asset IDs/bytes. Do not blindly rerun, replace assets, move tags,
delete releases or use clobber. Separately authorized recovery can rerun the original
run: it retains the original sequence/source, only fills genuinely missing draft
assets, and refuses conflicting bytes or identity. A published complete release is
read-only, including one subsequently promoted. Rebuilding changed source requires
a new genuine PR merge and sequence, never a fallback release of the old identity.

Release discovery remains paginated and rejects duplicate matching tags. After an
ID is discovered or returned by successful creation, verification reads the release
directly by ID with cache revalidation requested; a stale list omitting a newly
created draft does not imply deletion. Conflicting listed IDs, a direct-ID failure,
wrong tag/source or unconfirmed state still stop the attempt. No read failure
causes a write retry.

## Explicit Milestone selection

Run the **Milestone** workflow on `main` only after a user chooses one existing,
successful Rolling tag. Supply `tag` and repeat it exactly as `confirm_tag`.
The workflow rejects non-Rolling tags, drafts, wrong source/version, missing,
unexpected or changed assets and checksum/embedded descriptor mismatches.
It snapshots release/asset IDs and bytes twice before its single PATCH and again
afterwards, comparing them with the original publication seal (not merely with
replacement checksums). Only `prerelease=false` and `make_latest=true` change on the original
release; no build, renumbering, new tag/release, asset upload, title or body edit occurs.
An ambiguous write result must be inspected, not automatically retried.

Publication and promotion do not install, deploy, restart the host, mutate module
data or contact an external deployment service. Those need separate authorization.
