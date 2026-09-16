# Contributing to Cockpit File

English and Chinese issues and pull requests are welcome. Start with the
[module scope and contracts](docs/README.md). Keep file business in this repository
and generic host contracts in [Cockpit](https://github.com/waksana/cockpit).

## Local workflow

Use Node **24.20.0** and pnpm **10.34.5**. Follow the
[SDK preparation and build steps](docs/installation.md); `.cockpit-sdk` is generated
from the exact host commit in `tooling/host-sdk.json`, not from moving main or
another installation's dependencies.

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
Do not commit generated SDKs, node_modules, dist, archives or local data.

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

## Changing the SDK pin

Update `tooling/host-sdk.json` deliberately to a reviewed immutable host commit
and matching package/API version. Regenerate the SDK, update dependency metadata
only when required, and exercise the final module archive with that host.
The pin may refer to a not-yet-merged host change; disclose that dependency in
installation and release notes rather than claiming the latest host release works.

## Releases

The [release guide](docs/releases.md) owns version tags and the exact `.tgz`
artifact. No npm publication, deployment or service restart is performed by CI.
Contributions are licensed under [GPL-3.0-only](LICENSE).
Report vulnerabilities through the [private security channel](SECURITY.md).
