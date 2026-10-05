# Coding Agent sandbox images (C1b)

Digest-pinned, scanned and signed images that run untrusted code for the Coding Agent. Everything here
is additive to the Website Builder sandbox: the same `ProjectSandboxService` and the same runtime
hardening, with the image itself now a verified artifact instead of a tag.

## ⚠️ Read first: the catalog entries are placeholders

`docker/sandbox/images.json` currently contains **placeholder digests** derived deterministically from
`npati-sandbox-<variant>-1`. No image has been built, pushed or signed yet, so every entry has
`status: "unverified"` and its SBOM in `docker/sandbox/sbom/` is a **fallback document without a
package inventory** (syft was unavailable where it was generated).

Consequences, stated plainly:

- `node scripts/sandbox-image-verify.mjs` passes, but it prints one warning per placeholder entry.
- A deployment must not point `NPATI_SANDBOX_IMAGE` at these references; the runtime-side check (C1b
  wiring) must require `status: "verified"` and a matching digest, which none of them has.
- `node scripts/sandbox-image-verify.mjs --require-verified` fails on purpose until a real build,
  scan and signature have happened. Use it as the deployment gate.

## Catalog contract (`docker/sandbox/images.json`)

```json
{
  "schemaVersion": 1,
  "registry": "ghcr.io/npati-ai",
  "images": [
    {
      "id": "sandbox-node-1",
      "variant": "node",
      "reference": "ghcr.io/npati-ai/npati-sandbox-node@sha256:<64 hex>",
      "digest": "sha256:<64 hex>",
      "status": "verified",
      "signature": { "tool": "cosign", "identity": "<workflow identity>", "issuer": "https://token.actions.githubusercontent.com" },
      "sbomPath": "docker/sandbox/sbom/sandbox-node-1.spdx.json",
      "scan": { "tool": "trivy", "at": "<ISO date>", "critical": 0, "high": 0 },
      "waiver": null,
      "previousReference": null,
      "createdAt": "<ISO date>"
    }
  ]
}
```

- `reference` is the only thing a session may start from: `repo@sha256:<64 hex>`, never a tag.
- `status` is one of `unverified`, `verified`, `deprecated`, `revoked`.
  - `unverified` — built but not scanned/signed yet; not deployable (`--require-verified` fails).
  - `verified` — scan passed (critical = 0, high = 0 or waived) and `cosign verify` matched the
    expected identity/issuer.
  - `deprecated` — superseded by a newer generation; still startable for pinned sessions, no new ones.
  - `revoked` — must not be started (for example an unfixable critical CVE); running sessions are
    re-created on the current digest with notification.
- `waiver` is `null` or `{ "owner": "<person>", "reason": "<why>", "expiresAt": "<ISO date>" }`; an
  expired waiver is a hard failure.
- `previousReference` is the rollback target and must itself be digest-pinned.
- The digest inside `reference` must equal the `digest` field; two entries may not share a digest.

Schema version 1 is immutable in meaning: adding optional fields is compatible, changing or removing a
field requires `schemaVersion: 2` and an upcaster for readers (same rule as C1a persisted formats).

## Variants

| Variant | Dockerfile | Toolchain |
|---|---|---|
| base | `docker/sandbox/Dockerfile.base` | alpine/node base + git, ripgrep, build-base, make, g++, patch, diffutils, jq, curl, openssh-client, pnpm, yarn |
| node | `Dockerfile.node` | base + python3, pip, php, composer (mixed repositories are common) |
| python | `Dockerfile.python` | base + pytest 8.3.3, ruff 0.6.9, mypy 1.11.2, poetry 1.8.4, uv 0.4.20 |
| php | `Dockerfile.php` | base + php extensions, composer |
| go | `Dockerfile.go` | base + Go toolchain, `GOTOOLCHAIN=local` (no runtime toolchain download) |
| rust | `Dockerfile.rust` | base + rustc/cargo, per-user `CARGO_HOME` |
| java | `Dockerfile.java` | base + OpenJDK 21, Maven, Gradle |

Go, Rust and Java exist because C1 deliberately deferred them: detection already reported those
languages, and now the runtime to actually run their verify commands ships too.

Every variant is `USER 10001:10001`, has no docker socket, no setuid helper and no privileged
requirement, and takes its base with `ARG BASE_IMAGE=<repo>@sha256:<digest>` — a floating tag cannot
be substituted because `scripts/sandbox-image-verify.mjs` rejects any `FROM` that is neither
digest-pinned nor an ARG placeholder, and rejects `:latest` outright.

`apps/agent-api/Dockerfile.project-sandbox` remains the CI smoke build of the default variant. Its
`ARG BASE_IMAGE` defaults to a tag so the existing CI/compose jobs keep working; production passes
`--build-arg BASE_IMAGE=node:24-alpine@sha256:<digest>`.

## Pipelines

All scripts are plain Node (no TypeScript loader, no build step) and never spawn a missing tool
silently: without Docker/syft/trivy/cosign they warn and continue only under `--dry-run`, otherwise
they fail with a clear message. `verify` needs no external tool at all.

| Script | Purpose |
|---|---|
| `scripts/sandbox-image-build.mjs` | resolves the upstream digest, builds `Dockerfile.base`, pushes it, builds every variant against the base digest, pushes, resolves each real digest and writes `images.json` (status stays `unverified`) |
| `scripts/sandbox-image-sbom.mjs` | `syft <ref> -o spdx-json` into `docker/sandbox/sbom/`; deterministic fallback document with a warning when syft is missing |
| `scripts/sandbox-image-scan.mjs` | trivy (or grype); `critical > 0` → exit 1 and no publish; `high > 0` without a valid waiver → exit 1; results written into the catalog |
| `scripts/sandbox-image-sign.mjs` | `cosign sign --yes` then `cosign verify --certificate-identity <identity> --certificate-oidc-issuer <issuer>`; an entry becomes `verified` only after verification passes |
| `scripts/sandbox-image-verify.mjs` | the local guard (see below); no Docker needed |

Local guard (`npm run audit:sandbox-images`, also wired into the `platform` job of `ci.yml`):

1. every catalog `reference` matches `@sha256:<64 hex>`; `:latest` is rejected in `reference` and
   `previousReference`;
2. `digest` equals the digest inside `reference`; digests are unique and ids are unique;
3. every entry has an existing `sbomPath`;
4. `status` is one of the four values; `verified` entries carry a cosign record with identity/issuer;
5. `scan.critical` must be 0; `scan.high > 0` requires an unexpired waiver with owner and reason;
6. `scan.at` must be at most `NPATI_CODE_MAX_IMAGE_AGE_DAYS` (default 14) days old for `verified` and
   `deprecated` entries;
7. every variant Dockerfile exists, is digest-pinned or ARG-based, ends as `USER 10001:10001` and never
   mentions `--privileged` or `docker.sock`;
8. `unverified` entries are a warning by default and a **hard failure** under `--require-verified`.

`docker/sandbox/.negative-check.json` is the guard's self-test fixture: it is deliberately invalid and
`node scripts/sandbox-image-verify.mjs --catalog docker/sandbox/.negative-check.json` must exit 1 (the
CI `verify` job asserts exactly that). Deleting it is fine, but then that CI step needs removing too.

## CI (`.github/workflows/sandbox-images.yml`)

- **Triggers:** `workflow_dispatch` (optional single variant, optional dry run), weekly `schedule`
  (`0 3 * * 1`, inside the 14-day window), and `push` to `docker/sandbox/**`, the image scripts or the
  workflow itself.
- **`verify`** — the local guard, plus the self-test above; no Docker, seconds to run, and it gates the
  build job.
- **`build`** (matrix over the six variants) — `permissions: contents: read, packages: write,
  id-token: write`; logs in to GHCR, installs cosign, trivy and syft, then runs build → SBOM → scan →
  sign → guard again, and uploads the updated catalog and SBOMs. **A CRITICAL finding exits the scan
  step non-zero, so the sign step never runs, the entry stays `unverified`, and nothing is published as
  usable.** The same holds for a digest mismatch: the build script refuses placeholder digests and
  writes nothing to the catalog when it cannot resolve a real one.
- **`rescan`** (schedule/dispatch) — re-scans the published digests; on CRITICAL it comments on an
  existing `security,sandbox-images` issue or opens one, and fails the run.

The main `ci.yml` `platform` job additionally runs `npm run audit:sandbox-images`, so a hand-edited
catalog fails ordinary CI even without touching the images workflow.

## Rotation, revoking and rollback

1. **Weekly rebuild** (the scheduled workflow) or **out of band** on a critical CVE in a base image,
   language runtime or tool.
2. The new build gets a new catalog **generation** (`sandbox-node-1` → `sandbox-node-2`); the old entry
   becomes `deprecated` with `previousReference` pointing at it, so rollback is a pointer change.
3. Rollout is staged through the C1a flags (`code.shell`, `code.full_auto_sandbox`, per-company), never
   by swapping a digest under running sessions: **a session keeps the digest it was created with**, so a
   long run cannot change its runtime mid-flight.
4. A `revoked` digest forces new sessions onto the current one and re-creates running sandboxes with a
   user notification; the C1c AuditLog records the allow/revoke decision (image decisions are
   privileged and fail closed).
5. Rollback on a bad image = move `reference` back to `previousReference`, or simply disable the
   feature flag; both are actions without a schema change, as required by the C1a rollback rule.

## Runtime hardening (enforced by the runner, verified per image)

Enforced today by `docker-sandbox-provider.ts`: `--cap-drop ALL`, `--read-only` rootfs with a tmpfs
`/workspace`, `--security-opt no-new-privileges`, per-run `--internal` network plus the egress proxy,
non-root user, and CPU/memory/pids/disk limits. Image decisions add: digest pinning, a signed
provenance record (cosign keyless, GitHub OIDC identity above), an SBOM per digest, and a scan with a
14-day freshness policy.

## Kernel-level isolation: gVisor / Kata / Firecracker decision

The C0 audit asked whether a user-space kernel or a microVM should replace plain `runc`. Decision for
C1b: **stay on `runc` with the hardening above, and keep the option open behind an interface.**

- What stronger isolation buys: gVisor (user-space kernel) and Kata/Firecracker (microVM) reduce the
  blast radius of a kernel-level container escape, which is the main residual risk of running
  model-generated code.
- What it costs: gVisor changes syscall semantics (some build tools and language runtimes misbehave),
  Kata/Firecracker needs KVM on the host (not available on every Dokploy/VPS target, and nested
  virtualisation is often unavailable), plus a new operational surface (node pools, runtime classes) and
  a measurable performance cost for the install/build loops the agent does constantly.
- Decision now: the threat model (T1–T14 in `docs/coding-agent/00-audit.md`) puts **network egress,
  secret handling and workspace escape** ahead of kernel escapes, and those are addressed by the egress
  proxy (C4b), SecretLease (C4) and the digest-pinned, non-root, capability-free container. The runner
  container itself mounting the host docker socket remains the documented trust assumption.
- Follow-up (not implemented here): a `SandboxRuntimeProvider` interface — `run(spec)` / `stop(id)` /
  `capabilities()` — so a gVisor or Kata provider can be added for privileged customers without
  touching the agent loop. Re-evaluate when G1/R1 are passed or when a customer requires
  kernel-level isolation in writing.
