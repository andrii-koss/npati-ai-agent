# Local Next.js build and preview recovery — 2026-10-09

## Reported failure

The chat generated and saved the Next.js store, but the build/preview stage failed with `Sandbox image not found`. The affected run was `d33f8e60-2d07-4504-94f2-2e74ed4eb3c4`; the saved project was `624c05d9-da40-4756-bb76-0cbb886aed6a`.

## Causes and changes

1. Both runtime images were absent from local Docker. The local environment referenced an obsolete sandbox digest, and an ignored local Compose override launched Node directly, bypassing the image preparation entrypoint. Restored the sandbox and egress images, corrected the local tag, and removed that command override while retaining the local MinIO configuration.
2. The runner entrypoint now reuses existing images, prepares missing tagged images, and resolves the sandbox tag to its actual digest. An explicitly configured missing digest still fails instead of silently changing the requested production image. The Compose healthcheck verifies that both runtime images exist; an HTTP health response alone previously hid their absence.
3. Starting the preview passed internal Git hardening variables through the restricted caller environment and was rejected. Background requests now send only the permitted caller variables; the runner injects its trusted Git hardening environment after validation. The Data Studio integration test now uses the real environment validator.
4. The generated client SDK iterated a Set using `for...of`, which failed the Next.js ES5 TypeScript configuration. Changed notification dispatch to `Set.forEach`, and repaired that SDK file in the existing saved project without disabling type checks.
5. Snapshot provisioning and backup metadata creation inserted the same snapshot ID twice. Metadata registration now updates the matching provisioned snapshot; scheduled backup errors are caught and logged instead of terminating the API process.

## Actual verification

- Rebuilt and deployed the local API, company worker, and sandbox runner with the existing local Compose configuration. No user volumes were removed.
- Ran the saved store's real dependency installation and `npm run build` in its sandbox: exit code 0. Next.js 14.2.35 built `/`, `/auth`, and `/shop`.
- Started the saved project's preview through the authenticated project API. After the final API deployment, started it again and verified HTTP 200 and HTML through the web container.
- Recorded `last_build_status=success` for this specific project only after verifying the actual successful build. The original failed run/card remains historical.
- Created a real development backup through the authenticated API: HTTP 201, snapshot kind `manual`.
- API TypeScript, standalone SDK ES5 compilation, lint, and the targeted preview, sandbox diagnostics, environment validation, dependency security, website bootstrap, and backup tests were checked. This is not a claim that every repository test passes.

## Limits of this verification

This verified recovery and execution of the user's already generated store, not a new model-driven chat run. Preview session tracking currently lives in API memory, so an API restart requires starting Preview again. The existing background process timeout/restart policy was not changed in this repair. The sandbox architecture and company-agent permission architecture were retained.
