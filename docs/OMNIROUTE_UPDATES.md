# Updating OmniRoute

Current baseline: **v3.8.50**, commit
`5458026c216f77a3da68ea49152dc33470cfe2cb`.

OmniRoute is upstream infrastructure, not an NPATI customization surface.
Do not update it from a moving branch or an unpinned `latest` image.

## Update process

1. Review the latest stable upstream release and its license/security notes.
2. Create a dedicated update branch in NPATI Agent.
3. Fetch the stable tag inside `vendor/omniroute` and check it out detached.
4. Update the submodule pointer and both values in `OMNIROUTE_VERSION`.
5. Review upstream Dockerfile, required services, ports, environment variables,
   and `/api/monitoring/health` behavior for changes.
6. Pull the matching versioned OmniRoute image and rebuild NPATI images.
7. Run type checks, automated tests, Compose validation, and the complete local stack.
8. Resolve API incompatibilities in `packages/omniroute-adapter` first.
9. Verify the NPATI Web flow and Agent API health payload before merging.

Expected flow:

```text
current version → fetch stable version → update branch → update pin
→ rebuild Docker → tests → adapter fixes → NPATI smoke test → merge
```

Rollback means restoring the previous submodule pointer and version file, then
rebuilding. NPATI custom code should normally remain unchanged.

## Patches

The baseline has zero OmniRoute patches. If a source patch becomes unavoidable,
store the smallest possible documented patch under `patches/omniroute/`; never
place NPATI UI, branding, or business logic in upstream files.
