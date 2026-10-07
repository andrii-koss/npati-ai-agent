#!/usr/bin/env node
/**
 * C13: shared bootstrap for the capability-audit gates.
 *
 * `scripts/verify-capability-matrix.mjs` and `scripts/upgrade-gate.mjs` used to read the inventory with a
 * regex over the base array literal + `eval()`, so they could not see `CAPABILITY_CATALOG.push(...)` /
 * `CAPABILITY_MATRIX.push(...)` — the exact way the catalog grew on C9/C11/C12. They now import the
 * resolved TypeScript modules and read the exported arrays themselves.
 *
 * Two things make that possible from a plain `node scripts/*.mjs` invocation, without new dependencies:
 *   1. type stripping has to be in `transform` mode. The module graph needs it (the effective-capability
 *      graph uses syntax plain `--experimental-strip-types` rejects), and an unflagged Node 22 refuses
 *      `.ts` outright, so the script re-executes itself once with `--experimental-transform-types`;
 *   2. `module.register()` installs a resolve hook for the repository's extensionless relative imports.
 *
 * The re-execution uses `stdio: "inherit"` on purpose: output and exit code stay exactly what the caller
 * asked for, and no new pipe is created (piped child stdio is denied under the file sandbox).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Marks a process that has already re-executed, so a missing flag can never become an infinite loop. */
export const REEXEC_MARKER = "NPATI_CAPABILITY_AUDIT_RUNTIME";

/** Path of the published tool-schema manifest, relative to the repository root. */
export const PUBLISHED_TOOL_SCHEMA_MANIFEST_PATH = "apps/agent-api/src/code-tool-schemas.published.json";

/**
 * Guarantees the process can import TypeScript, re-executing itself when it cannot. Returns normally only
 * when the current process is able to import `.ts`; otherwise it exits with the child's status.
 */
export function ensureTypeScriptTransformRuntime(argv = process.argv, execPath = process.execPath) {
  if (process.features.typescript === "transform") return "in-process";
  if (process.env[REEXEC_MARKER] === "1") return "already-reexecuted";
  const entry = argv[1];
  if (!entry) throw new Error("cannot re-execute for TypeScript: no entry script in argv[1]");
  const result = spawnSync(execPath, ["--experimental-transform-types", "--no-warnings", entry, ...argv.slice(2)], {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, [REEXEC_MARKER]: "1" },
  });
  if (result.error) {
    console.error(`[capability-audit] failed to re-execute node with --experimental-transform-types: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

/**
 * Imports the real auditor module (`packages/shared/src/capability-catalog-audit.ts`). Every capability
 * number the gates report comes from these functions, which read the exported stores at call time.
 */
export async function loadCapabilityCatalogAudit(argv = process.argv, execPath = process.execPath) {
  ensureTypeScriptTransformRuntime(argv, execPath);
  register(new URL("./capability-audit-resolve-hook.mjs", import.meta.url));
  return import("../packages/shared/src/capability-catalog-audit.ts");
}

/** Reads the published tool-schema manifest the static parity check compares the catalog against. */
export function readPublishedToolSchemaManifest(rootDir) {
  const file = path.join(rootDir, PUBLISHED_TOOL_SCHEMA_MANIFEST_PATH);
  return { file, manifest: JSON.parse(readFileSync(file, "utf8")) };
}

/** Title and fact keys of the four checks, in the order the gates report them. */
export const CAPABILITY_AUDIT_CHECKS = [
  {
    key: "staticCatalogIntegrity",
    title: "static catalog exact integrity",
    facts: ["catalogTotal", "matrixTotal", "registryTotal", "agentCallable", "runtimeOnly", "uniqueInventoryIds", "uniqueTestSuites", "registryValidationErrors"],
  },
  {
    key: "staticManifestParity",
    title: "static manifest/schema parity",
    facts: ["manifestVersion", "manifestTools", "catalogCodeTools"],
  },
  {
    key: "runtimeOverlayIntegrity",
    title: "runtime overlay integrity",
    facts: ["overlayProviderId", "overlayCount", "overlayHash", "overlayHashRecomputes", "staticTotalWithNullOverlay", "staticTotalWithProbeOverlay", "combinedTotalWithProbeOverlay"],
  },
  {
    key: "combinedInspectorView",
    title: "combined Capability Inspector view",
    facts: ["inspectorAll", "inspectorAgentCallable", "inspectorRuntimeOnly", "combinedTotal", "combinedOverlayTotal", "combinedSources", "combinedTotalWithProbeOverlay", "inspectorAllWithProbeOverlay"],
  },
];

/**
 * Prints the four checks with the values that were actually measured, and returns whether all of them
 * passed. Both gates use this so a reader sees the same verdict in the same order.
 */
export function printCapabilityAuditReport(report, write = (line) => process.stdout.write(`${line}\n`)) {
  let index = 0;
  for (const check of CAPABILITY_AUDIT_CHECKS) {
    index += 1;
    const result = report[check.key];
    const facts = check.facts
      .filter((key) => result.facts[key] !== undefined)
      .map((key) => `${key}=${result.facts[key]}`)
      .join(", ");
    write(`  ${result.ok ? "✓" : "✗"} [${index}/4] ${check.title}: ${result.ok ? "OK" : "FAILED"} (${facts})`);
    for (const issue of result.issues) {
      write(`      ✗ ${issue.code}: ${issue.detail}`);
    }
  }
  write(`  ${report.ok ? "✓" : "✗"} capability audit: ${report.ok ? "4/4 checks passed" : "FAILED"}`);
  return report.ok;
}

/** Repository root resolved from this file, for scripts that only need paths. */
export const SCRIPTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
