# Contributing to Cockpit File

English and Chinese issues and pull requests are welcome. Start with the
[module scope and contracts](docs/README.md). Keep file business in this repository
and generic host contracts in [Cockpit](https://github.com/waksana/cockpit).

## Local workflow

Use Node **24.20.0** and pnpm **10.34.5**. Follow the
[registry authentication and build steps](docs/installation.md). The exact
`@waksana/cockpit-module-sdk` package and integrity are locked in `pnpm-lock.yaml`;
building needs no host checkout or generated SDK.

For a new checkout/worktree, use that guide's
[independent dependency setup](docs/installation.md#worktree-setup).
Plain documentation changes need no dependency install or product build.

Create a short branch from main. Run the smallest relevant existing tests, then
the required checks for the proposed change:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
```

Packaging requires clean committed source and a matching build receipt; rebuild
after committing, then use `pnpm package` and `pnpm verify:package ARCHIVE`.
Do not commit credentials, node_modules, dist, archives or local data.

## Pull requests

Main requires a PR, the successful GitHub Actions **Required checks** status on an
up-to-date base, and resolved conversations. The policy also applies to admins;
force pushes and deletion are disabled. A second-person approval is not required
for this single-maintainer project. Merge commits preserve branch history and
merged remote branches are deleted automatically.

Describe scope, exact validation commands/results, failures and untested areas.
Use synthetic files, sessions and loopback fixtures. Never run checks against
real native homes, production services, credentials or personal files.
Documentation-only changes need link/anchor and factual checks, not unrelated
native experiments.

## Changing the SDK dependency

Verify publication and both developer and repository Actions access first.
Update the exact version in `package.json` and regenerate the lockfile with pnpm
against GitHub Packages. Never substitute a local tarball, generated declarations,
peer-resolution bypass or `skipLibCheck`. SDK semver does not prove host compatibility:
keep runtime API/capability checks and exercise the final archive against the
immutable host in `tooling/host-integration.json`. That pin is an integration input,
not a build dependency. Use the common, `/backend`, `/frontend` and `/runtime` public
entries as appropriate; keep React supplied by `context.react`.

## Releases

### Immutable installation versions

Do not bump a version for every commit. Before packaging changed content for
installation or deployment, compare with versions already delivered: changed
package bytes require a fresh semantic version (normally the next patch for a
compatible fix). The same module ID and version may only reproduce the same
bytes/digest. A source SHA or digest records provenance; neither replaces the
module version or permits replacing an installed identity.

Synchronize `package.json`, `cockpit.module.json`, any embedded versions and
applicable lockfile metadata, then update current-source compatibility and release
notes. Preserve historical release statements. Rebuild from the final clean commit
and verify its exact CI artifact. Never delete installed directories or force an
installer bypass to reuse a version. Version preparation and merge do not authorize
tags, Releases, installation or restart.

The [release guide](docs/releases.md) owns version tags and the exact `.tgz`
artifact. No npm publication, deployment or service restart is performed by CI.
Contributions are licensed under [GPL-3.0-only](LICENSE).
Report vulnerabilities through the [private security channel](SECURITY.md).
