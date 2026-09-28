# First-release readiness

Audit date: 2026-09-28.

## Verdict

The current tree is a viable `v0.1.0` beta release candidate. The functional release
gate is green, but the repository should not be announced as an open-source release
until a license is selected and the first GitHub Actions run passes.

## Verified locally

- `npm run typecheck` passes for every workspace.
- `npm test` passes 1,543 tests in 170 files; 2 optional tests are skipped.
- `npm run build` produces the API and web builds.
- `npm run audit:capabilities` validates all 306 catalog entries.
- `npm run gate:upgrade` reports a green release gate, validates all 24 migrations,
  guards 6 upstream contracts, and finds no duplicate custom adapter.
- `docker compose config --quiet` validates the Compose model.

The audited catalog contains 181 verified, 55 partially implemented, and 70 reserved
or not-yet-implemented capabilities. A reserved row is not evidence that the named
feature works.

## Platform support

Docker Compose is the supported installation path for the first release. The CI workflow
tests the locked Node installation, typecheck, capability audit, complete test suite,
and build on Ubuntu, Windows, and macOS. An Ubuntu Docker job validates Compose and builds
the API and web images.

Local Windows verification is complete. Cross-platform support becomes release evidence
only when the workflow passes for the release commit. A clean-host Ubuntu Compose smoke
test is still recommended before publishing the release tag.

## Required before public open-source release

- Select and add a root `LICENSE`. Without it, the public can view the source but does
  not receive permission to use, modify, or redistribute it.
- Push the candidate and require the `platform`, `docker`, and `release-gate` jobs
  to pass.
- Run one credential-free clean-install smoke test, then one production-like deployment
  check with deployment secrets and provider credentials.

## Recommended repository hygiene

- Add `SECURITY.md` with a private vulnerability-reporting channel.
- Add `CONTRIBUTING.md` and a code of conduct before inviting outside contributions.
- Create a changelog entry and signed or annotated `v0.1.0` tag.
- Keep branch protection configured so the CI release gate is required.

## Known boundaries

