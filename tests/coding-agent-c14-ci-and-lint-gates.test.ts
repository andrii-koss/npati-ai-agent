import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATE_ARTIFACT_PATH, SECURITY_GATE_TESTS, writeGateArtifact } from "../scripts/lib/run-security-gate.mjs";
import {
  LINT_RULES,
  RECORDED_ALLOWANCES,
  evaluateScan,
  loadBaseline,
  runSelfTest,
  scanLintSources,
  scanText,
} from "../scripts/lib/lint-guard.mjs";

/**
 * C14 (hardening): the two gates this step added or repaired are themselves pinned as artifacts.
 *
 * 1. **The CI contract: automated CI is off on purpose, and the configuration is intact.** C14 made this
 *    workflow run on `push`, `pull_request` and a weekly `schedule` — and the owner has since disabled every
 *    automatic trigger, because the repository is private and has no paid Actions minutes: on the last automatic
 *    run **all** jobs failed in about 2 seconds without starting (`macos-*`/`windows-*` are not offered to a
 *    private repository at all), so the checks were never evidence, only a red signal. The state this file now
 *    pins is the deliberate one, and it is pinned in **both** directions: `.github/workflows/ci.yml` must have
 *    `workflow_dispatch` as its **only** trigger (no `push`, no `pull_request`, no `schedule`), *and* the removed
 *    trigger contract — the three triggers, the 25-entry behaviour-path filter both automatic triggers shared,
 *    and the cron — must survive verbatim as a machine-readable RE-ENABLE RECIPE, so turning CI back on is one
 *    commit instead of a restoration from git history. That is a **stronger** statement than the C14 pin it
 *    replaces: "`push` is present with these paths" became "no automatic trigger exists at all, and here is
 *    exactly what is missing". The same two properties are then pinned over **every** workflow in the repository
 *    (not only `ci.yml`), with the recipe itself used as the mutation input of the non-vacuity proof: putting any
 *    trigger the recipe names back into a copy must make the check fail, and removing the one trigger that
 *    stayed must make it fail too. The jobs and steps are untouched and are asserted to be untouched — "CI is
 *    off" must not become "the CI configuration was deleted".
 *
 *    What this suite cannot do is *execute* GitHub Actions: it verifies the files statically. The runtime
 *    equivalence is the set of commands the file names, each of which is runnable locally and is exercised by
 *    the security gate (`npm run security-gate`, which runs `tests/coding-agent-c6-eval.test.ts` among its
 *    suites) — the honest statement is "CI config verified statically and by running the same commands locally;
 *    the real GitHub run was not performed here, and with no automatic trigger it will not be performed by
 *    GitHub either".
 *
 * 2. **`npm run lint` is not decoration** — the guard must fire on a real violation and stay silent on the
 *    current tree. Both directions are asserted, and the guard's own self-test (every rule fires on its own
 *    violation, stays silent on the neighbouring legal shape) runs inside those assertions rather than being
 *    trusted.
 */

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ciPath = path.join(workspaceRoot, ".github", "workflows", "ci.yml");
const ciSource = readFileSync(ciPath, "utf8");
const ciLines = ciSource.split(/\r?\n/);

/** Comments are removed first: this file *documents* its invariants, and prose naming a key is not the key. */
function stripComment(line: string): string {
  const match = /(^|\s)#/.exec(line);
  if (!match) return line;
  return line.slice(0, match.index + (match[1] ?? "").length);
}

const ciCode = ciLines.map(stripComment);

/** The block under one top-level `key:` (everything until the next column-0 line). */
function topLevelBlock(lines: readonly string[], key: string): string {
  const start = lines.findIndex((line) => line === key);
  if (start < 0) return "";
  const out: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\S/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

/** Every job of a workflow, keyed by its name. */
function jobBlocks(lines: readonly string[]): Record<string, string> {
  const jobsIndex = lines.findIndex((line) => line === "jobs:");
  const blocks: Record<string, string> = {};
  if (jobsIndex < 0) return blocks;
  const body = lines.slice(jobsIndex + 1);
  for (let index = 0; index < body.length; index += 1) {
    const match = /^  ([a-z][a-z0-9-]*):$/.exec(body[index] ?? "");
    if (!match) continue;
    const name = match[1] ?? "";
    let end = body.length;
    for (let cursor = index + 1; cursor < body.length; cursor += 1) {
      if (/^  [a-z][a-z0-9-]*:$/.test(body[cursor] ?? "")) {
        end = cursor;
        break;
      }
    }
    blocks[name] = body.slice(index + 1, end).join("\n");
  }
  return blocks;
}

/** The `run:` commands of a workflow, in file order and comment-free. */
function runCommands(lines: readonly string[]): string[] {
  const commands: string[] = [];
  for (const line of lines) {
    const match = /^\s*(?:- )?run:\s*(\S.*)$/.exec(line);
    if (match?.[1]) commands.push(match[1].trim());
  }
  return commands;
}

/**
 * ---------------------------------------------------------------------------------------------------------------------
 * G1: the trigger contract of every workflow in the repository.
 *
 * There is no YAML parser in this repository's dependency tree (`yaml` and `js-yaml` are both absent from
 * `node_modules`, and adding one is a dependency decision for the owner), so the `on:` block is read
 * structurally — the same technique the rest of this file already uses for `ci.yml`. The three spellings that
 * matter are all recognisable from indentation: a bare mapping, an inline flow sequence (`on: [push]`) and the
 * scalar form (`on: push`). A missing or empty `on:` block is *reported* rather than read as "no triggers",
 * because "there is no trigger block" and "the trigger block is empty" are the same verdict but a different
 * thing to fix.
 * ---------------------------------------------------------------------------------------------------------------------
 */

const WORKFLOW_DIR = path.join(workspaceRoot, ".github", "workflows");
/** Every workflow in the repository, in a stable order. Read as data: the contract below covers all of them. */
const WORKFLOW_FILES: readonly string[] = readdirSync(WORKFLOW_DIR)
  .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
  .sort();
const WORKFLOW_SOURCES: ReadonlyMap<string, string> = new Map(
  WORKFLOW_FILES.map((file) => [file, readFileSync(path.join(WORKFLOW_DIR, file), "utf8")] as const),
);

/** Comment-free lines of any workflow source, by the same rule `ciCode` applies to `ci.yml`. */
function codeLines(source: string): string[] {
  return source.split(/\r?\n/).map(stripComment);
}

/**
 * Triggers that run a workflow **without a human choosing to run this workflow**. The list is a copy of the event
 * vocabulary GitHub offers for that shape; it is used for the explicit `no push / no pull_request / no schedule`
 * statement and for the recipe vocabulary check, not as the gate — the gate is that the only trigger present is
 * `workflow_dispatch`, which refuses an event nobody has thought of yet.
 */
const AUTOMATIC_TRIGGERS: readonly string[] = [
  "branch_protection_rule", "check_run", "check_suite", "create", "delete", "deployment", "deployment_status",
  "discussion", "discussion_comment", "fork", "gollum", "issue_comment", "issues", "label", "merge_group",
  "milestone", "page_build", "project", "project_card", "project_column", "public", "pull_request",
  "pull_request_review", "pull_request_review_comment", "pull_request_target", "push", "registry_package",
  "release", "repository_dispatch", "repository_import", "repository_vulnerability_alert", "schedule",
  "security_advisory", "sponsorship", "star", "status", "team_add", "workflow_call", "workflow_run",
];

/** The only trigger the repository allows today. Adding one is a deliberate act with a written reason. */
const ALLOWED_TRIGGERS: readonly string[] = ["workflow_dispatch"];

/** The triggers named by an `on:` block, plus whatever is structurally wrong with that block. */
function parseTriggers(source: string): { triggers: string[]; problems: string[] } {
  const lines = codeLines(source);
  const start = lines.findIndex((line) => /^on:/.test(line));
  if (start < 0) return { triggers: [], problems: ["trigger_block_missing: there is no top-level `on:` key"] };
  const header = lines[start] ?? "";
  const after = header.slice(header.indexOf(":") + 1).trim();
  const triggers: string[] = [];
  const problems: string[] = [];
  if (after) {
    // `on: [push, pull_request]` — a flow sequence — or the scalar spelling `on: push`.
    const flow = /^\[(.*)\]$/.exec(after);
    if (flow) triggers.push(...(flow[1] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
    else triggers.push(after);
  } else {
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.trim() === "") continue; // a blank line, or a comment line the stripper emptied (the recipe)
      if (/^\S/.test(line)) break; // the next top-level key ends the `on:` block
      const match = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):/.exec(line);
      // Deeper indentation is a trigger's own options (`inputs:`, `paths:`, `types:`), not a trigger.
      if (match?.[1]) triggers.push(match[1]);
    }
  }
  if (triggers.length === 0) problems.push("trigger_list_empty: the `on:` block names no trigger at all");
  if (triggers.length !== new Set(triggers).size) problems.push("trigger_duplicate: a trigger is named more than once");
  return { triggers, problems };
}

interface TriggerVerdict {
  /** The triggers the `on:` block names, in file order. */
  triggers: string[];
  /** Those of them that fire without a human choosing this workflow. */
  automatic: string[];
  /** Those of them that are not `workflow_dispatch` today. */
  disallowed: string[];
  /** Whether the workflow can still be run by hand. */
  manual: boolean;
  /** Stable, greppable failure codes; empty means the workflow satisfies the deliberate state. */
  problems: string[];
}

/** What one workflow says about its own triggers. Pure, so a mutated copy can be judged by the same function. */
function triggerVerdict(source: string): TriggerVerdict {
  const parsed = parseTriggers(source);
  const automatic = parsed.triggers.filter((trigger) => AUTOMATIC_TRIGGERS.includes(trigger));
  const disallowed = parsed.triggers.filter((trigger) => !ALLOWED_TRIGGERS.includes(trigger));
  const manual = parsed.triggers.includes("workflow_dispatch");
  const problems = [...parsed.problems];
  for (const trigger of automatic) problems.push(`trigger_automatic:${trigger}`);
  for (const trigger of disallowed) {
    if (!automatic.includes(trigger)) problems.push(`trigger_not_allowed:${trigger}`);
  }
  if (!manual) problems.push("trigger_manual_missing: no `workflow_dispatch`, so the workflow cannot even be run by hand");
  return { triggers: parsed.triggers, automatic, disallowed, manual, problems };
}

/** A copy with `trigger:` injected as the first entry of the `on:` block — the mutation the proof below uses. */
function withTrigger(source: string, trigger: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start < 0) throw new Error("withTrigger: the `on:` block is gone, so the mutation cannot be applied");
  lines.splice(start + 1, 0, `  ${trigger}:`);
  return lines.join("\n");
}

/**
 * A copy whose `on:` block has no trigger left. The RE-ENABLE RECIPE is a **comment**, so it is kept (it is not a
 * trigger), while every indented line of the block is dropped — an `on:` whose only content is prose is the state
 * this control has to be able to report.
 */
function withoutAnyTrigger(source: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start < 0) throw new Error("withoutAnyTrigger: the `on:` block is gone, so the negative control cannot be built");
  const kept: string[] = [];
  let index = start + 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*#/.test(line)) {
      kept.push(line); // a comment belongs to the recipe, not to the trigger list
      continue;
    }
    if (line.trim() === "") continue; // blank lines inside a block that is being emptied
    if (/^\S/.test(line)) break; // the next top-level key ends the block
    // an indented, non-comment line is a trigger (or one of its options): dropped
  }
  return [...lines.slice(0, start + 1), ...kept, ...lines.slice(index)].join("\n");
}

/**
 * One fenced block of the RE-ENABLE RECIPE, read as data — `null` when the block is absent **or** opened and
 * never closed, so a half-deleted recipe is a failure of its own rather than an empty list.
 */
function reenableRecipeBlock(source: string, name: string): string[] | null {
  const lines = source.split(/\r?\n/);
  const begin = `# --- BEGIN RE-ENABLE RECIPE (${name}) ---`;
  const end = `# --- END RE-ENABLE RECIPE (${name}) ---`;
  const start = lines.findIndex((line) => line.trim() === begin);
  if (start < 0) return null;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === end) return body;
    body.push(line.replace(/^\s*#\s?/, ""));
  }
  return null;
}

/** The `name:` rows of a recipe block, as bare trigger names. */
function recipeTriggerNames(source: string, name = "triggers"): string[] {
  return (reenableRecipeBlock(source, name) ?? [])
    .map((entry) => /^([a-z_][a-z0-9_]*):$/.exec(entry.trim())?.[1])
    .filter((entry): entry is string => typeof entry === "string");
}

/** The `- "…"` rows of a recipe block, as bare path patterns. */
function recipePathEntries(source: string, name = "paths"): string[] {
  return (reenableRecipeBlock(source, name) ?? [])
    .map((entry) => /^- "(.+)"$/.exec(entry.trim())?.[1])
    .filter((entry): entry is string => typeof entry === "string");
}

/** The `- cron: "…"` rows of a recipe block, as bare cron expressions. */
function recipeCronEntries(source: string, name = "schedule"): string[] {
  return (reenableRecipeBlock(source, name) ?? [])
    .map((entry) => /^- cron: "(.+)"$/.exec(entry.trim())?.[1])
    .filter((entry): entry is string => typeof entry === "string");
}

const onBlock = topLevelBlock(ciCode, "on:");
const blocks = jobBlocks(ciCode);
const commands = runCommands(ciCode);

describe("[C14] [security-gate] the CI workflow's gate structure is intact and its triggers are manual-only", () => {
  it("runs on manual dispatch only — no push, no pull_request, no schedule", () => {
    const verdict = triggerVerdict(ciSource);
    expect(verdict.problems).toEqual([]);
    expect(verdict.manual).toBe(true);
    // `toEqual` on the whole list rather than `toContain`: a *fourth* trigger added later fails here too, so the
    // deliberate state cannot be widened silently while nobody is looking.
    expect(verdict.triggers).toEqual(["workflow_dispatch"]);
    expect(verdict.automatic).toEqual([]);
    for (const removed of ["push", "pull_request", "schedule"]) {
      expect(verdict.triggers, removed).not.toContain(removed);
      expect(onBlock, removed).not.toMatch(new RegExp(`^\\s*${removed}:`, "m"));
    }
    // No cron survives in the file's *code*: a `schedule:` restored without its cron, or a cron left behind, is a
    // half-restored trigger. The recipe below keeps the expression as a comment, which is why this reads `ciCode`.
    expect(ciCode.filter((line) => /cron:/.test(line))).toEqual([]);
  });

  it("keeps the removed trigger contract in a re-enable recipe, complete and addressable", () => {
    // This replaces the C14 pin that asserted `push` and `pull_request` carried identical path lists. The new pin
    // is stronger in the way that matters while CI is off: it asserts the *single* canonical list both triggers
    // must be restored with, the triggers themselves, and the cron — so re-enabling is one commit and the list
    // cannot rot while it waits.
    expect(recipeTriggerNames(ciSource)).toEqual(["push", "pull_request", "schedule"]);
    expect(recipeCronEntries(ciSource)).toEqual(["0 4 * * 1"]);
    const paths = recipePathEntries(ciSource);
    expect(paths).toHaveLength(25);
    for (const required of [
      "apps/**",
      "packages/**",
      "tests/**",
      "scripts/**",
      "docker/**",
      "services/**",
      "docker-compose*.yml",
      "package.json",
      "package-lock.json",
      "tsconfig*.json",
      "vitest*.ts",
      ".env.example",
      ".env.production.example",
      ".github/workflows/**",
      // G1 (D21): the filter is *addressable*, not only globbed. `docs/**` is in it because the gate-size guard
      // reads the number of suites out of `docs/coding-agent/security-gate-report.md`, so a documentation edit
      // can make a gate suite red — "docs-only changes do not need CI" was true before that guard existed.
      "docs/**",
    ]) {
      expect(paths, required).toContain(required);
    }
    for (const named of [
      "apps/agent-api/src/sandbox-*.ts",
      "apps/agent-api/src/sandbox-*.mjs",
      "apps/agent-api/src/runner-readiness.ts",
      "apps/agent-api/src/code-tool-runtime.ts",
      "apps/agent-api/src/code-tool-registry.ts",
      "apps/agent-api/src/code-tool-executors.ts",
      "apps/agent-api/src/code-policy-engine.ts",
      "apps/agent-api/src/code-shell-classifier.ts",
      "apps/agent-api/src/coding-agent-runner.ts",
      "apps/agent-api/src/approvals-repository.ts",
    ]) {
      expect(paths, named).toContain(named);
    }
    // The recipe says in prose that both automatic triggers must use this one list; the assertion above is what
    // makes it a single source instead of two lists that could drift.
    expect(ciSource).toContain("use the `(paths)` list verbatim for **both** `push:` and `pull_request:`");
  });

  it("runs every gate the acceptance criterion names, including the ones that were missing", () => {
    for (const command of [
      "npm ci",
      "npm run security-gate",
      "npm run typecheck",
      "npm run typecheck:tests",
      "npm run lint",
      "npm run audit:capabilities",
      "npm run audit:sandbox-images",
      // C14 (owner decision 1): the suite is run in full by the quarantine gate, not by a bare `npm test` step —
      // the assertion below pins that this is the *only* test step, so there are not two sources of truth.
      "npm run test:known-failures",
      // G1 (D5): the web suite ran in no workflow at all before this step.
      "npm run test:web",
      "npm run build",
      "npm run eval:smoke",
      "npm run gate:upgrade",
    ]) {
      expect(commands).toContain(command);
    }
  });

  it("runs the full suite through the quarantine gate, never through a second, softer step", () => {
    const platform = blocks["platform"] ?? "";
    expect(platform).toContain("run: npm run test:known-failures");
    // A bare `npm test` step beside it would be a second verdict on the same run — and the softer of the two
    // would be the one a reader believes. The quarantine script itself is what invokes vitest.
    expect(commands).not.toContain("npm test");
    const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
    expect(pkg.scripts["test:known-failures"]).toContain("scripts/check-known-failures.mjs");
    expect(existsSync(path.join(workspaceRoot, "known-failures.json"))).toBe(true);
    // The known-failures step is the *only* place the suite runs: `npm test` stays the plain full-suite command it
    // always was, so a developer's run and CI's run cannot drift into two different definitions.
    expect(pkg.scripts.test).toBe("vitest run");
    // The verdict is kept as evidence even when the step fails.
    expect(platform).toContain("artifacts/known-failures-report.json");
  });

  it("has no step that may fail softly", () => {
    // Any mention in a *code* line (comments are stripped above) fails, because a `continue-on-error` is how a
    // gate becomes advisory without anyone noticing.
    expect(ciCode.filter((line) => /continue-on-error/.test(line))).toEqual([]);
  });

  it("keeps the security-gate job unconditional: no path filter, no if:, its suite list is the contract", () => {
    const gate = blocks["security-gate"] ?? "";
    expect(gate).toContain("run: npm run security-gate");
    expect(gate).not.toContain("continue-on-error");
    expect(/^\s*if:/m.test(gate)).toBe(false);
    expect(/^\s*paths:/m.test(gate)).toBe(false);
  });

  it("runs the eval smoke as its own job, keeps its report as evidence and blocks the release", () => {
    const evals = blocks["evals"] ?? "";
    expect(evals).toContain("run: npm run eval:smoke");
    expect(evals).toContain("artifacts/coding-agent-eval-smoke-report.json");
    // A run that produced no report fails: the report is the evidence, not a nicety.
    expect(evals).toContain("if-no-files-found: error");
    /**
     * G1 (D6): `security-gate` is in `needs` now. The old pin named the three jobs explicitly and the gate was
     * not one of them, so a release could be green while the one mandatory gate was red. The list is parsed
     * rather than matched as a literal string, so the assertion names the property (every blocking job is in
     * it, and the gate is one of them) instead of one ordering, and a future removal of any of them fails.
     */
    const release = blocks["release-gate"] ?? "";
    const needs = /needs:\s*\[([^\]]*)\]/.exec(release)?.[1]?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
    expect(needs).toContain("security-gate");
    for (const job of ["platform", "docker", "evals"]) expect(needs, job).toContain(job);
    // A `needs` list without the gate is the regression this replaced; the literal is asserted absent.
    expect(release).not.toContain("needs: [platform, docker, evals]");
  });

  it("keeps the gate verdict as evidence, and the artifact writer really writes it", () => {
    // G1 (D20): the gate wrote its vitest report into `mkdtempSync(...)` and deleted it in `finally`, so the
    // job uploaded nothing at all. The contract is two-sided: the script produces the artifact, the job
    // requires it.
    const gate = blocks["security-gate"] ?? "";
    expect(gate).toContain("actions/upload-artifact@v4");
    expect(gate).toContain("artifacts/security-gate-report.json");
    // `error`, not `warn`: a gate run whose evidence is missing is a failed job, the same contract the eval
    // report uses. And the job still carries no `if:` (asserted above), so no conditional evidence either.
    expect(gate).toContain("if-no-files-found: error");
    expect(GATE_ARTIFACT_PATH).toBe("artifacts/security-gate-report.json");

    // Behavioural half, in a temporary root so the repository is untouched: the writer creates the directory,
    // writes the summary under the documented name, and returns the repository-relative path it wrote.
    const root = mkdtempSync(path.join(tmpdir(), "npati-gate-artifact-"));
    try {
      const written = writeGateArtifact(root, { gate: "security-gate", ok: true, suites: { configured: SECURITY_GATE_TESTS.length } });
      expect(written).toEqual({ ok: true, path: GATE_ARTIFACT_PATH, error: null });
      const parsed = JSON.parse(readFileSync(path.join(root, GATE_ARTIFACT_PATH), "utf8"));
      expect(parsed).toMatchObject({ gate: "security-gate", ok: true });
      expect(parsed.suites.configured).toBe(SECURITY_GATE_TESTS.length);
      // A root that cannot be written is *reported*, never thrown: the artifact is evidence and must not be
      // able to change the gate's verdict. The obstruction is a **file** where the artifact directory must be,
      // which `mkdirSync(..., { recursive: true })` refuses on every platform.
      const blocked = mkdtempSync(path.join(tmpdir(), "npati-gate-artifact-blocked-"));
      try {
        writeFileSync(path.join(blocked, "artifacts"), "not a directory\n", "utf8");
        const unwritable = writeGateArtifact(blocked, { gate: "security-gate" });
        expect(unwritable.ok).toBe(false);
        expect(typeof unwritable.error).toBe("string");
        expect(unwritable.path).toBe(GATE_ARTIFACT_PATH);
      } finally {
        rmSync(blocked, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the web suite as its own step over its own config, so the quarantine baseline cannot move", () => {
    const platform = blocks["platform"] ?? "";
    expect(platform).toContain("run: npm run test:web");
    // Exactly one step, invoked only through the script: an inline `--config` beside it would be a second
    // definition of the same suite.
    expect(commands.filter((command) => command === "npm run test:web")).toHaveLength(1);
    expect(commands.filter((command) => command.includes("vitest.web.config"))).toEqual([]);

    const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
    expect(pkg.scripts["test:web"]).toBe("vitest run --config vitest.web.config.ts");
    // The two configurations are disjoint on purpose: `apps/web` is in the web config only, so the files the
    // web step runs can never enter the quarantine run (which is what would move 10 files / 15 tests).
    const webConfig = readFileSync(path.join(workspaceRoot, "vitest.web.config.ts"), "utf8");
    const rootConfig = readFileSync(path.join(workspaceRoot, "vitest.config.ts"), "utf8");
    expect(webConfig).toContain("apps/web/src/**/*.test.ts");
    expect(rootConfig).not.toContain("apps/web");
    expect(rootConfig).toContain('"tests/**/*.test.ts"');
  });

  it("runs the database half of the mandatory gate as its own job, over the production PostgreSQL image", () => {
    /**
     * G1 (item 2 / D1). The database-level audit guarantees cannot be proven without PostgreSQL, while the
     * hermetic `security-gate` job must stay runnable where there is none — and it fails a run that reports a
     * skipped test, so a database suite cannot simply be added to its list. This job is the answer: a second
     * mandatory job whose connection string is always set, whose steps run the two database scripts, and which the
     * release gate `needs`. Pinned here so it cannot be dropped, softened or made conditional without a red suite.
     */
    const job = blocks["security-gate-db"] ?? "";
    // The production image, because migration 014 runs `CREATE EXTENSION IF NOT EXISTS vector`.
    expect(job).toContain("image: pgvector/pgvector:pg17");
    expect(job).toContain("pg_isready");
    expect(job).toContain("DATABASE_URL: postgres://");
    // Both halves of the database gate, each invoked through its own script (never inline).
    expect(job).toContain("run: npm run security-gate:db");
    expect(job).toContain("run: npm run gate:upgrade:db");
    expect(commands.filter((command) => command === "npm run security-gate:db")).toHaveLength(1);
    expect(commands.filter((command) => command === "npm run gate:upgrade:db")).toHaveLength(1);
    // Unconditional, like the hermetic job: no `if:`, no path filter, no soft failure.
    expect(/^\s*if:/m.test(job)).toBe(false);
    expect(job).not.toContain("continue-on-error");
    expect(/^\s*paths:/m.test(job)).toBe(false);
    // A run that produced no verdict artifact fails, so the job's evidence is mandatory on both scripts.
    expect(job).toContain("artifacts/security-gate-db-report.json");
    expect(job).toContain("artifacts/upgrade-gate-db-report.json");
    expect(job).toContain("if-no-files-found: error");

    const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
    expect(pkg.scripts["security-gate:db"]).toBe("node scripts/run-security-gate.mjs --db");
    expect(pkg.scripts["gate:upgrade:db"]).toBe("node scripts/upgrade-gate.mjs --db");

    // The database gate blocks the release beside the hermetic one — "mandatory" is `needs`, not a job name.
    const release = blocks["release-gate"] ?? "";
    const needs = /needs:\s*\[([^\]]*)\]/.exec(release)?.[1]?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
    expect(needs).toContain("security-gate-db");
  });

  it("keeps the eval smoke a hermetic reuse of the existing corpus, not a second runner", () => {
    const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
    expect(pkg.scripts["eval:smoke"]).toContain("tests/coding-agent-c6-eval.test.ts");
    expect(pkg.scripts["eval:smoke"]).toContain("artifacts/coding-agent-eval-smoke-report.json");
    // No second harness: the corpus suite is still the security-gate suite it always was, and the C14 suites
    // are registered in the same fixed list (a suite that exists but is not listed is a suite nobody runs).
    expect(SECURITY_GATE_TESTS).toContain("tests/coding-agent-c6-eval.test.ts");
    expect(SECURITY_GATE_TESTS).toContain("tests/coding-agent-c14-model-profile-flags.test.ts");
    expect(SECURITY_GATE_TESTS).toContain("tests/coding-agent-c14-ci-and-lint-gates.test.ts");
    expect(new Set(SECURITY_GATE_TESTS).size).toBe(SECURITY_GATE_TESTS.length);
  });
});

/**
 * G1: the deliberate state, pinned over **every** workflow rather than over `ci.yml` alone.
 *
 * The owner disabled automated CI because the repository is private and has no paid Actions minutes: every job of
 * the last automatic run failed in about two seconds without starting, so the checks were never evidence. The risk
 * of that decision (nothing blocks a merge or a release any more) is recorded in
 * `docs/coding-agent/security-gate-report.md` §6; what this suite owns is the *configuration* half: automatic
 * triggers do not come back by accident, the configuration is not deleted, and the disabled triggers are
 * documented precisely enough to be restored in one commit.
 */
describe("[G1] [security-gate] no workflow in this repository has an automatic trigger", () => {
  it("is exactly the three workflows that shipped, each still carrying jobs", () => {
    // A fourth file is not automatically wrong — but it must be a deliberate act, and this assertion is where the
    // author of one is asked to say so. A *missing* file is the "someone deleted the configuration" case.
    expect(WORKFLOW_FILES).toEqual(["ci.yml", "mutation-branch.yml", "sandbox-images.yml"]);
    for (const [file, source] of WORKFLOW_SOURCES) {
      expect(source.trim().length, file).toBeGreaterThan(0);
      expect(source, file).toContain("jobs:");
    }
  });

  it("gives every workflow exactly one trigger, and it is manual dispatch", () => {
    for (const [file, source] of WORKFLOW_SOURCES) {
      const verdict = triggerVerdict(source);
      expect(verdict.problems, file).toEqual([]);
      // The whole list, not a membership test: any event that is not `workflow_dispatch` fails, including one
      // GitHub adds after this test was written.
      expect(verdict.triggers, file).toEqual(["workflow_dispatch"]);
      expect(verdict.automatic, file).toEqual([]);
      expect(verdict.disallowed, file).toEqual([]);
      expect(verdict.manual, file).toBe(true);
      // Named individually as well, so a failure says *which* automatic trigger came back.
      for (const automatic of ["push", "pull_request", "schedule"]) {
        expect(verdict.triggers, `${file}:${automatic}`).not.toContain(automatic);
      }
    }
  });

  it("keeps every job and step, and keeps each removed trigger as a machine-readable re-enable recipe", () => {
    // "CI is off" must not become "the CI configuration was deleted": the jobs of `ci.yml` are still all there,
    // and every workflow still says in code-adjacent prose exactly which triggers it lost.
    // G1 (item 2 / D1): `security-gate-db` is added, not substituted — the five jobs that shipped stay, and the
    // database half of the mandatory gate is pinned as its own job rather than folded into the hermetic one.
    expect(Object.keys(jobBlocks(ciCode)).sort()).toEqual([
      "docker",
      "evals",
      "platform",
      "release-gate",
      "security-gate",
      "security-gate-db",
    ]);
    for (const [file, source] of WORKFLOW_SOURCES) {
      expect(Object.keys(jobBlocks(codeLines(source))).length, file).toBeGreaterThan(0);
      expect(reenableRecipeBlock(source, "triggers"), `${file}: no (triggers) re-enable block`).not.toBeNull();
      const removed = recipeTriggerNames(source);
      expect(removed.length, `${file}: the recipe names no removed trigger`).toBeGreaterThan(0);
      expect(new Set(removed).size, `${file}: a trigger is listed twice`).toBe(removed.length);
      for (const trigger of removed) {
        // A recipe may only describe triggers that genuinely ran without a human; `workflow_dispatch` is the one
        // that stayed, so naming it as something to restore would misdescribe the current state.
        expect(AUTOMATIC_TRIGGERS, `${file}:${trigger}`).toContain(trigger);
      }
      expect(removed, file).not.toContain("workflow_dispatch");
      // And it says what to do with them, so the recipe is not a pile of orphaned YAML fragments.
      expect(source, file).toContain("RE-ENABLE RECIPE");
    }
  });

  it("is not vacuous: restoring any trigger the recipe names is reported", () => {
    // The mutation input is the recipe itself, so the recipe, the check and this proof cannot drift apart: a
    // trigger added to a recipe without the check noticing is impossible, because the recipe *is* the input.
    for (const [file, source] of WORKFLOW_SOURCES) {
      const removed = recipeTriggerNames(source);
      expect(removed.length, `${file}: nothing to restore, so this control would be decorative`).toBeGreaterThan(0);
      for (const trigger of removed) {
        const mutated = withTrigger(source, trigger);
        expect(mutated, `${file}:${trigger}`).not.toBe(source);
        const verdict = triggerVerdict(mutated);
        expect(verdict.triggers, `${file}:${trigger}`).toContain(trigger);
        expect(
          verdict.problems.some((problem) => problem.includes(trigger)),
          `${file}:${trigger} was restored and the check stayed silent (problems=${verdict.problems.join(",")})`,
        ).toBe(true);
        // The original file still passes, so the mutation and not the fixture is what turned the check red.
        expect(triggerVerdict(source).problems, file).toEqual([]);
      }
    }
  });

  it("is not vacuous in the other direction: a workflow left with no trigger at all is reported", () => {
    // Without this half, the check could be satisfied by a file whose `on:` block was emptied — which is not the
    // deliberate state either, it is a workflow nobody can run.
    for (const [file, source] of WORKFLOW_SOURCES) {
      const verdict = triggerVerdict(withoutAnyTrigger(source));
      expect(verdict.manual, file).toBe(false);
      expect(verdict.triggers, file).toEqual([]);
      expect(
        verdict.problems.some((problem) => problem.startsWith("trigger_manual_missing")),
        `${file}: an empty on-block was accepted (problems=${verdict.problems.join(",")})`,
      ).toBe(true);
    }
  });
});

describe("[C14] [security-gate] npm run lint is a real guard, not decoration", () => {
  it("is a script that runs the guard and the existing web XSS scan", () => {
    const pkg = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
    expect(pkg.scripts.lint).toContain("scripts/lint-guard.mjs");
    expect(pkg.scripts.lint).toContain("scripts/scan-web-xss.mjs");
    expect(commands).toContain("npm run lint");
    expect(existsSync(path.join(workspaceRoot, "scripts", "lint-guard.mjs"))).toBe(true);
    expect(existsSync(path.join(workspaceRoot, "scripts", "lint-baseline.json"))).toBe(true);
  });

  it("proves its own detector: the self-test passes and every rule fires on its own violation", () => {
    const selfTest = runSelfTest();
    expect(selfTest.failures).toEqual([]);
    expect(selfTest.ok).toBe(true);
    expect(selfTest.checks).toBeGreaterThanOrEqual(LINT_RULES.length);
    expect(LINT_RULES.map((rule) => rule.id).sort()).toEqual([
      "as-any",
      "console-log",
      "focused-or-skipped-test",
      "ts-suppression",
    ]);

    // One real violation per rule, through the same scanner the gate uses.
    expect(scanText("apps/demo/src/new-module.ts", "const value = input as any;").map((finding) => finding.rule))
      .toEqual(["as-any"]);
    expect(scanText("apps/demo/src/new-module.ts", "// @ts-ignore sql text").map((finding) => finding.rule))
      .toEqual(["ts-suppression"]);
    expect(scanText("tests/demo.test.ts", 'describe.only("focused", () => {});').map((finding) => finding.rule))
      .toEqual(["focused-or-skipped-test"]);
    expect(scanText("apps/demo/src/new-module.ts", "console.log('debug');").map((finding) => finding.rule))
      .toEqual(["console-log"]);
    // …and the neighbouring legal shapes stay silent, which is what keeps the guard from being noise.
    expect(scanText("apps/demo/src/new-module.ts", "const value = input as string;\nlogger.log('kept');")).toEqual([]);
    expect(scanText("tests/demo.test.ts", 'it("still runs", () => {});\nconst x = it.skipLater;')).toEqual([]);
  });

  it("fails a cast the baseline does not record, and tolerates one it does", () => {
    const newFile = scanText("apps/demo/src/new-module.ts", "const value = input as any;");
    const unknown = evaluateScan(newFile, { baseline: {} });
    expect(unknown.ok).toBe(false);
    expect(unknown.violations).toHaveLength(1);
    expect(unknown.violations[0]?.detail).toContain("not in scripts/lint-baseline.json");

    // A recorded count is a cap, not a licence: exceeding it fails, staying under it passes.
    const recorded = { "apps/demo/src/new-module.ts": { "as-any": 1 } };
    expect(evaluateScan(scanText("apps/demo/src/new-module.ts", "const value = input as any;"), { baseline: recorded }).ok).toBe(true);
    const growth = evaluateScan(scanText("apps/demo/src/new-module.ts", "const a = b as any;\nconst c = d as any;"), { baseline: recorded });
    expect(growth.ok).toBe(false);
    expect(growth.violations).toHaveLength(1);

    // An unlisted occurrence of an allowance rule fails too, so `npm run lint` is not only about casts.
    const unlisted = evaluateScan(scanText("apps/demo/src/new-module.ts", "console.log('debug');"), { baseline: {} });
    expect(unlisted.ok).toBe(false);
    expect(unlisted.violations).toHaveLength(1);
  });

  it("reads real files: a temp tree with a violation fails, a clean one passes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "npati-lint-guard-"));
    try {
      mkdirSync(path.join(root, "apps", "demo", "src"), { recursive: true });
      writeFileSync(path.join(root, "apps", "demo", "src", "bad.ts"), "export const value = input as any;\n", "utf8");
      writeFileSync(path.join(root, "apps", "demo", "src", "clean.ts"), "export const value: string = String(input);\n", "utf8");
      const scan = scanLintSources(root);
      expect(scan.scannedFiles).toBe(2);
      expect(scan.findings.map((finding) => finding.file)).toEqual(["apps/demo/src/bad.ts"]);
      const verdict = evaluateScan(scan.findings, { baseline: {} });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations).toHaveLength(1);
      expect(verdict.violations[0]?.file).toBe("apps/demo/src/bad.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives no false positive on the repository it guards", () => {
    const baseline = loadBaseline();
    expect(baseline.missing).toBe(false);
    expect(Object.keys(baseline.counts).length).toBeGreaterThan(0);
    const scan = scanLintSources(workspaceRoot);
    expect(scan.scannedFiles).toBeGreaterThan(500);
    const verdict = evaluateScan(scan.findings, { baseline: baseline.counts });
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
    // Every recorded allowance must still match something: a ledger that rots into a blanket permission is how
    // a guard stops meaning anything.
    expect(verdict.allowancesChecked).toBe(RECORDED_ALLOWANCES.length);
  });
});
