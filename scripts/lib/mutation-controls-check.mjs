/**
 * G1 item 3: the mutation matrix and its guard — the same pattern as `attack-catalogue-check.mjs`.
 *
 * `tests/coding-agent-c14-gate-mutation-sensitivity.test.ts` neutralises five guards **in memory** and proves
 * they are load-bearing in their own seam. That is a different claim from "the real `scripts/run-security-gate.mjs`
 * goes red when the guard is deleted from the code": an in-memory substitution never reaches the gate. The
 * decoy-branch runner (`scripts/security-gate-mutation-branch.mjs`) closes that gap by mutating a file inside an
 * isolated worktree and running the real gate; this module is the contract that keeps its matrix honest, so a
 * fabricated row cannot describe a mutation that no longer resolves.
 *
 * The guard is deliberately split in the same two halves the catalogue uses:
 *
 *  - **static** (`validateMutationControls`, run by the gate **before** vitest): every row must name a real
 *    file, an anchor that occurs in it **exactly once**, a declared exit code that matches its kind, a written
 *    rationale, and — for a `decoy` row — a failing suite that is a file on disk, that is a member of the
 *    gate's fixed suite list, and a test title that really exists in that suite as `it("…")`. The matrix must
 *    contain at least one `decoy` and at least one `cosmetic` row: a matrix of only decoys cannot tell "the
 *    gate catches the weakening" from "the gate fails on any change".
 *  - **rendering** (`renderMutation`): the pure function that produces the mutated source. The runner only
 *    writes what this returns, and the suite that guards this module executes it on every real row, so "the
 *    mutation is what the matrix says" is a computed value and not a promise.
 *
 * Nothing here is a test-framework dependency, and nothing here spawns a process: the readers defend
 * themselves against a missing or malformed matrix, because a caller may be handing them external input.
 *
 * G1 (item 5): this file is the **library** half of `scripts/mutation-controls-check.mjs` and carries no
 * shebang — a `#!/usr/bin/env node` first line is a syntax error when a bundler hands the file to `node:vm`
 * untransformed, which is what made eight gate suites report "no tests at all" in a git worktree. The
 * executable is the thin wrapper `scripts/mutation-controls-check.mjs`, which calls `main()` from here.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { itTitlesIn } from "./attack-catalogue-check.mjs";

/** The matrix's location, relative to the repository root. */
export const MUTATION_CONTROLS_PATH = "security-gate/mutation-controls.json";

/**
 * G1 (item 5): where the gate's fixed suite list lives now that the gate is split into a library and a thin
 * CLI wrapper. Both spellings are declared so a checkout that still has the pre-split layout keeps working.
 */
export const GATE_SCRIPT_PATH = "scripts/lib/run-security-gate.mjs";
export const LEGACY_GATE_SCRIPT_PATH = "scripts/run-security-gate.mjs";

/** The two kinds a row may declare. `decoy` must break the gate; `cosmetic` must not change its verdict. */
export const MUTATION_CONTROL_KINDS = ["decoy", "cosmetic"];

/** How a row edits its file. `delete_line` removes the whole line the anchor sits on. */
export const MUTATION_CONTROL_OPS = ["replace", "delete_line"];

/** The minimum length of a written rationale, so "n/a" cannot be an argument. */
export const MUTATION_RATIONALE_MIN_CHARS = 40;

/**
 * The suite that holds the in-memory controls. A row may name one by id: that is the honest declaration that
 * this guard is *also* proved in its own seam (or, with `null`, that it has none).
 */
export const IN_MEMORY_CONTROLS_SUITE = "tests/coding-agent-c14-gate-mutation-sensitivity.test.ts";

/** Reads the matrix. Returns `{ controls, matrix, error }`; `error` is prose for the gate log, never thrown. */
export function loadMutationControls(root = process.cwd(), matrixPath = MUTATION_CONTROLS_PATH) {
  const file = path.isAbsolute(matrixPath) ? matrixPath : path.join(root, matrixPath);
  if (!existsSync(file)) return { controls: [], matrix: null, error: `missing file ${matrixPath}` };
  try {
    const matrix = JSON.parse(readFileSync(file, "utf8"));
    const controls = Array.isArray(matrix?.controls) ? matrix.controls : null;
    if (!controls) return { controls: [], matrix, error: `${matrixPath} has no \`controls\` array` };
    return { controls, matrix, error: null };
  } catch (error) {
    return { controls: [], matrix: null, error: `unreadable ${matrixPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Where a row's anchor sits and how often it occurs.
 *
 * The occurrence count is the whole point: a `replace` with two matches, or a `delete_line` whose anchor is a
 * substring of several lines, is not a deterministic mutation, and the guard refuses it instead of letting the
 * runner edit whichever line it happened to find first.
 */
export function locateMutationAnchor(source, control) {
  const text = String(source ?? "");
  const find = typeof control?.find === "string" ? control.find : "";
  if (!find) return { found: false, occurrences: 0, line: null };
  let occurrences = 0;
  let index = text.indexOf(find);
  const first = index;
  while (index >= 0) {
    occurrences += 1;
    index = text.indexOf(find, index + find.length);
  }
  if (occurrences === 0 || first < 0) return { found: false, occurrences: 0, line: null };
  return { found: true, occurrences, line: text.slice(0, first).split("\n").length };
}

/**
 * The mutated source a row produces, as a pure function of the current file text.
 *
 * `replace` substitutes the anchor; `delete_line` removes the entire line the anchor sits on and keeps every
 * other byte (including that line's own `\r` on a CRLF checkout, because the split is on `\n` only). Both
 * refuse to guess: an anchor that is absent, or present more than once, is an error result rather than an
 * arbitrary edit.
 */
export function renderMutation(source, control) {
  const text = String(source ?? "");
  const op = typeof control?.op === "string" ? control.op : "";
  const located = locateMutationAnchor(text, control);
  if (!located.found) return { ok: false, error: `anchor not found: ${JSON.stringify(control?.find ?? "")}`, text: null, line: null };
  if (located.occurrences !== 1) {
    return { ok: false, error: `anchor occurs ${located.occurrences} times, so the mutation is not deterministic`, text: null, line: null };
  }
  if (op === "replace") {
    const replacement = typeof control?.replace === "string" ? control.replace : null;
    if (replacement === null) return { ok: false, error: "op `replace` needs a string `replace`", text: null, line: null };
    return { ok: true, error: null, text: text.replace(control.find, replacement), line: located.line };
  }
  if (op === "delete_line") {
    const lines = text.split("\n");
    const index = located.line === null ? -1 : located.line - 1;
    if (index < 0 || index >= lines.length) return { ok: false, error: "the anchor line could not be located", text: null, line: null };
    lines.splice(index, 1);
    return { ok: true, error: null, text: lines.join("\n"), line: located.line };
  }
  return { ok: false, error: `op \`${op}\` is not one of ${MUTATION_CONTROL_OPS.join(", ")}`, text: null, line: null };
}

/**
 * The static guard. `suites` is the gate's fixed suite list (the gate script must pass it, because this module
 * may not import the gate that imports it).
 *
 * Every issue carries a stable `code` and the row's `id`, so a red gate names the row to fix.
 */
export function validateMutationControls(input) {
  const root = input?.root ?? process.cwd();
  const controls = Array.isArray(input?.controls) ? input.controls : null;
  const suites = Array.isArray(input?.suites) ? input.suites : [];
  const inMemorySource = (() => {
    try {
      return readFileSync(path.join(root, IN_MEMORY_CONTROLS_SUITE), "utf8");
    } catch {
      return null;
    }
  })();
  const issues = [];
  const add = (code, id, detail) => issues.push({ code, id, detail });

  if (!controls || controls.length === 0) {
    add("mutation_controls_empty", "-", "`controls` must be a non-empty array of mutation rows");
    return { ok: false, issues, counts: { decoy: 0, cosmetic: 0 } };
  }

  const suiteSet = new Set(suites);
  const titlesCache = new Map();
  const titlesFor = (suite) => {
    if (!titlesCache.has(suite)) {
      try {
        titlesCache.set(suite, itTitlesIn(readFileSync(path.join(root, suite), "utf8")));
      } catch {
        titlesCache.set(suite, null);
      }
    }
    return titlesCache.get(suite);
  };
  const sourceCache = new Map();
  const sourceFor = (file) => {
    if (!sourceCache.has(file)) {
      try {
        sourceCache.set(file, readFileSync(path.join(root, file), "utf8"));
      } catch {
        sourceCache.set(file, null);
      }
    }
    return sourceCache.get(file);
  };

  const counts = { decoy: 0, cosmetic: 0 };
  const seenIds = new Set();
  for (const row of controls) {
    const id = typeof row?.id === "string" && row.id.trim() ? row.id : "-";
    if (id !== "-") {
      if (seenIds.has(id)) add("mutation_id_duplicate", id, `the id \`${id}\` is used by more than one row`);
      seenIds.add(id);
    }
    for (const field of ["id", "kind", "op", "file", "find", "rationale"]) {
      if (typeof row?.[field] !== "string" || !row[field].trim()) {
        add("mutation_field_missing", id, `field \`${field}\` must be a non-empty string`);
      }
    }
    if (typeof row?.rationale === "string" && row.rationale.trim().length < MUTATION_RATIONALE_MIN_CHARS) {
      add("mutation_rationale_too_short", id, `\`rationale\` must explain the non-vacuity argument in at least ${MUTATION_RATIONALE_MIN_CHARS} characters`);
    }
    const kind = typeof row?.kind === "string" ? row.kind : "";
    if (kind && !MUTATION_CONTROL_KINDS.includes(kind)) {
      add("mutation_kind_unknown", id, `kind \`${kind}\` is not one of ${MUTATION_CONTROL_KINDS.join(", ")}`);
    } else if (kind) {
      counts[kind] += 1;
    }
    if (typeof row?.op === "string" && row.op && !MUTATION_CONTROL_OPS.includes(row.op)) {
      add("mutation_op_unknown", id, `op \`${row.op}\` is not one of ${MUTATION_CONTROL_OPS.join(", ")}`);
    }
    if (row?.expectedGateExit !== 0 && row?.expectedGateExit !== 1) {
      add("mutation_expect_gate_exit_invalid", id, "`expectedGateExit` must be 0 or 1");
    } else if (kind === "decoy" && row.expectedGateExit !== 1) {
      add("mutation_expect_gate_exit_mismatch", id, "a decoy row removes a control, so `expectedGateExit` must be 1");
    } else if (kind === "cosmetic" && row.expectedGateExit !== 0) {
      add("mutation_expect_gate_exit_mismatch", id, "a cosmetic row changes nothing, so `expectedGateExit` must be 0");
    }
    if (row?.op === "replace") {
      if (typeof row.replace !== "string") add("mutation_field_missing", id, "op `replace` needs a string `replace`");
      else if (typeof row.find === "string" && row.replace === row.find) add("mutation_replace_identical", id, "`replace` is identical to `find`, so the mutation changes nothing");
    }
    if (typeof row?.find === "string" && row.find.trim() && row.find.includes("\n")) {
      add("mutation_anchor_spans_lines", id, "`find` must stay inside one line, so the anchor cannot drift with a line-ending change");
    }

    const file = typeof row?.file === "string" ? row.file : "";
    if (file.trim()) {
      if (!existsSync(path.join(root, file))) {
        add("mutation_file_missing", id, `file does not exist: ${file}`);
      } else {
        const source = sourceFor(file);
        if (source === null) {
          add("mutation_file_unreadable", id, `file could not be read: ${file}`);
        } else if (typeof row.find === "string" && row.find.trim()) {
          const located = locateMutationAnchor(source, row);
          if (!located.found) add("mutation_anchor_not_found", id, `the anchor is not present in ${file}: ${JSON.stringify(row.find)}`);
          else if (located.occurrences !== 1) add("mutation_anchor_not_unique", id, `the anchor occurs ${located.occurrences} times in ${file}; a mutation must be deterministic`);
          else {
            const rendered = renderMutation(source, row);
            if (!rendered.ok) add("mutation_render_failed", id, `the mutation does not render: ${rendered.error}`);
            else if (rendered.text === source) add("mutation_render_identical", id, "the rendered file is byte-identical to the original, so the mutation changes nothing");
          }
        }
      }
    }

    if (kind === "cosmetic") {
      if (row?.expectedFailingSuite !== null || row?.expectedFailingTest !== null) {
        add("mutation_cosmetic_declares_failure", id, "a cosmetic row must declare `expectedFailingSuite: null` and `expectedFailingTest: null`");
      }
    } else if (kind === "decoy") {
      for (const field of ["expectedFailingSuite", "expectedFailingTest"]) {
        if (typeof row?.[field] !== "string" || !row[field].trim()) {
          add("mutation_field_missing", id, `a decoy row must name \`${field}\``);
        }
      }
      const suite = typeof row?.expectedFailingSuite === "string" ? row.expectedFailingSuite : "";
      if (suite.trim()) {
        if (!existsSync(path.join(root, suite))) {
          add("mutation_expected_suite_missing", id, `the named failing suite does not exist: ${suite}`);
        } else if (!suiteSet.has(suite)) {
          add("mutation_expected_suite_not_in_gate", id, `the named failing suite ${suite} is not in the security-gate suite list, so it cannot be evidence`);
        } else {
          const titles = titlesFor(suite);
          if (!titles) add("mutation_expected_suite_unreadable", id, `the named failing suite could not be read: ${suite}`);
          else if (typeof row?.expectedFailingTest === "string" && row.expectedFailingTest && !titles.includes(row.expectedFailingTest)) {
            add("mutation_expected_title_not_found", id, `no it("${row.expectedFailingTest}") in ${suite}`);
          }
        }
      }
    }

    if (row?.inMemoryCounterpart === null || row?.inMemoryCounterpart === undefined) {
      // Declared as "this guard has no in-memory seam" — an honest answer, checked by the report, not a defect.
    } else if (typeof row.inMemoryCounterpart !== "string") {
      add("mutation_in_memory_counterpart_invalid", id, "`inMemoryCounterpart` must be a control id or null");
    } else if (!inMemorySource) {
      add("mutation_in_memory_suite_unreadable", id, `the in-memory control suite could not be read: ${IN_MEMORY_CONTROLS_SUITE}`);
    } else if (!inMemorySource.includes(`id: "${row.inMemoryCounterpart}"`)) {
      add("mutation_in_memory_counterpart_unknown", id, `no in-memory control with id \`${row.inMemoryCounterpart}\` is declared in ${IN_MEMORY_CONTROLS_SUITE}`);
    }
  }

  // Both directions are required, or the matrix cannot distinguish "sensitive" from "fails on anything".
  if (counts.decoy === 0) add("mutation_no_decoy_control", "-", "the matrix has no `decoy` row, so it proves nothing about a removed guard");
  if (counts.cosmetic === 0) add("mutation_no_cosmetic_control", "-", "the matrix has no `cosmetic` row, so a gate that fails on any change would look sensitive");

  return { ok: issues.length === 0, issues, counts };
}

/**
 * The gate's fixed suite list, parsed out of `scripts/lib/run-security-gate.mjs` rather than imported: this
 * module is imported *by* that library, so importing it back would be a cycle, and the CLI needs the list to
 * check that a row's named failing suite really is gate evidence. A parse that finds nothing is reported,
 * never guessed.
 */
export function gateSuiteListFrom(source) {
  const marker = "export const SECURITY_GATE_TESTS = [";
  const start = String(source ?? "").indexOf(marker);
  if (start < 0) return null;
  const end = String(source).indexOf("\n];", start);
  if (end < 0) return null;
  const suites = [];
  for (const match of String(source).slice(start, end).matchAll(/^\s*"([^"]+)",\s*$/gm)) {
    if (match[1] !== undefined) suites.push(match[1]);
  }
  return suites.length ? suites : null;
}

/**
 * The gate's suite list, read from the library the gate is built from. Returns `[]` when neither the current
 * nor the pre-split location exists, so the caller reports "not checked" instead of inventing a list.
 */
export function readGateSuiteList(root) {
  for (const relativePath of [GATE_SCRIPT_PATH, LEGACY_GATE_SCRIPT_PATH]) {
    try {
      const parsed = gateSuiteListFrom(readFileSync(path.join(root, relativePath), "utf8"));
      if (parsed) return parsed;
    } catch {
      // Try the next location.
    }
  }
  return [];
}

/** The CLI: the same verdict the gate logs, runnable by hand (`--matrix <path>` for a fabricated matrix). */
export function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex >= 0 && argv[rootIndex + 1] ? path.resolve(argv[rootIndex + 1]) : process.cwd();
  const matrixIndex = argv.indexOf("--matrix");
  const matrixPath = matrixIndex >= 0 && argv[matrixIndex + 1] ? argv[matrixIndex + 1] : MUTATION_CONTROLS_PATH;
  const state = loadMutationControls(root, matrixPath);
  if (state.error) {
    process.stdout.write(`[mutation-controls] FAILED: ${state.error}\n`);
    return 1;
  }
  const suites = readGateSuiteList(root);
  if (suites.length === 0) process.stdout.write("[mutation-controls] notice: the gate suite list could not be parsed, so suite membership is not checked\n");
  const verdict = validateMutationControls({ root, controls: state.controls, suites });
  process.stdout.write(
    `[mutation-controls] rows=${state.controls.length} decoy=${verdict.counts.decoy} cosmetic=${verdict.counts.cosmetic} ok=${verdict.ok} issues=${verdict.issues.length}\n`,
  );
  for (const issue of verdict.issues) process.stdout.write(`[mutation-controls]   ${issue.code} [${issue.id}]: ${issue.detail}\n`);
  return verdict.ok ? 0 : 1;
}
