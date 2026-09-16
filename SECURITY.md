# Security policy

## Scope and support

Cockpit File is experimental 0.x software. Fixes target the latest module release
and its documented host/API baseline; before the first release, they target main.
Mixed host/module versions and historical-data migration are not supported.

The module runs as trusted code in the Cockpit host process, not in a sandbox.
As explicitly configured by the product, new Agent file references may capture
any local regular file readable by the service user. Remote file URLs are not
downloaded automatically. Protect every module route with the host's authenticated
remote access boundary; Base64URL identifiers and checksums are not authentication.

## Report privately

Use **[Report a vulnerability](https://github.com/waksana/cockpit-file/security/advisories/new)**.
Do not publish unfixed vulnerability details in issues or pull requests.
If the private form is unavailable, request a private contact route without
including exploit details.

Include module version/source SHA, the host SDK pin, host/Node/platform versions,
the affected boundary, and a minimal synthetic reproduction. Do not attach tokens,
cookies, private keys, real files, native homes or conversation histories.
Do not probe the maintainer's service or other users' sessions.

The maintainer coordinates assessment, fixes and disclosure through the advisory.
There is no promised response or fix SLA. Agree on disclosure timing before
publishing details. These rules are not a claim that the module has passed a
security audit.
