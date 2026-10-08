import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECURITY_GATE_TESTS } from "../scripts/run-security-gate.mjs";

/**
 * C14 (post-step cleanup) — the two descriptions that had silently drifted are pinned to a source the guard
 * reads instead of remembers. Neither check holds a copy of the fact it checks: no phase name and no suite
 * count is written in this file (the last test proves that on this file's own literals), because a copy is
 * the second source of truth that drifts in the first place.
 *
 * 1. **The phase order.** The policy engine's header comment and the wiring comment in `app.ts` describe the
 *    sequence in which a privileged call is judged. Both had drifted: each listed eight of the eleven phases
 *    declared by the `PolicyPhase` union and named neither the group intersection, nor the step that decides
 *    whether a project's own instructions may be applied, nor the network gate — while all three really run.
 *    This suite derives the vocabulary from the union type in `code-policy-engine.ts` and the order from the
 *    first appearance of each phase name inside `evaluateInternal`, then fails when either comment omits a
 *    declared phase, names something that is not one, or states them in another order than the engine
 *    reaches them. A phase added to the union and forgotten in a comment is therefore a red suite.
 * 2. **The gate's size.** `docs/coding-agent/security-gate-report.md` stated 138 while the fixed list in
 *    `scripts/run-security-gate.mjs` held 144. The document is now read as data, every place it states the
 *    current size (the canonical sentence, the `--list` row, a bold number after an arrow, and the
 *    `suites=`/`present=` pair) must agree with the list, and the list itself is read twice — parsed out of
 *    the script's source and imported as the module's own export — so a parse that silently loses an entry
 *    cannot pass.
 *
 * Both halves are then shown to be non-vacuous by feeding the checkers **copies**: a phase removed from a
 * comment, two phases swapped, a wrong number in the document. The files on disk are never mutated.
 *
 * Honest limits: the "invents no phase" half reads snake_case identifiers out of a comment, which is what a
 * phase name always is; a comment inventing a single lowercase word that is not a phase is not caught by it.
 * The order half reads the *first* appearance of a phase name, which is the order in which a decision may
 * first be refused under that phase — the last two labels share one block (the dependency and migration
 * decisions are taken before the mode x risk matrix, which is the only place that refuses under the last
 * label), and both comments say so in prose.
 */

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_PATH = "tests/coding-agent-c14-policy-phase-and-gate-size-guard.test.ts";
const ENGINE_PATH = "apps/agent-api/src/code-policy-engine.ts";
const WIRING_PATH = "apps/agent-api/src/app.ts";
const GATE_SCRIPT_PATH = "scripts/run-security-gate.mjs";
const REPORT_PATH = "docs/coding-agent/security-gate-report.md";

/** The method whose call sites are the order of execution, and the two comments that describe it. */
const ENGINE_SIGNATURE = "private async evaluateInternal(request: PolicyRequest): Promise<PolicyResult>";
const ENGINE_COMMENT_MARKER = "Phase order is fixed";
const WIRING_COMMENT_MARKER = "every code tool execution decision passes through this single server-side";

/** The list that is the contract; the module export and the parsed source must agree on it. */
const GATE_ARRAY_MARKER = "export const SECURITY_GATE_TESTS = [";

/** Injected by the non-vacuity mutations; not a phase name, so `extra` reports it as an invention. */
const INVENTED_TOKEN = "phase_the_guard_injected";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(workspaceRoot, relativePath), "utf8");
}

/**
 * The body of one method, located by its signature and closed by brace depth. String, template and comment
 * regions are skipped, because a brace inside them (a template interpolation, a brace in a sentence) would
 * otherwise end the slice early and the guard would compare a truncated body as if it were the whole method.
 * The caller asserts anchors on the result, so a wrong slice fails loudly instead of quietly comparing less.
 */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`methodBody: signature not found: ${signature}`);
  const open = source.indexOf("{", start);
  if (open < 0) throw new Error(`methodBody: the signature has no body: ${signature}`);
  let depth = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`methodBody: unbalanced braces after the signature: ${signature}`);
}

/** The members of the union type, in declaration order — the phase vocabulary's only definition. */
function policyPhases(source: string): string[] {
  const marker = "export type PolicyPhase =";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`policyPhases: ${marker} is gone, so there is nothing to compare against`);
  const end = source.indexOf(";", start);
  if (end < 0) throw new Error("policyPhases: the union declaration is not terminated");
  const phases: string[] = [];
  for (const match of source.slice(start, end).matchAll(/"([a-z][a-z0-9_]*)"/g)) {
    const phase = match[1];
    if (phase !== undefined && !phases.includes(phase)) phases.push(phase);
  }
  if (phases.length === 0) throw new Error("policyPhases: the union parsed to nothing, which cannot be right");
  return phases;
}

/**
 * The order in which the method can first reach each phase: the first appearance of its name as a string
 * literal in the body. The literal carries both quotes, so a shorter phase name that is a prefix of a longer
 * one cannot match inside it, and the alternation is longest-first for the same reason.
 */
function phaseExecutionOrder(body: string, phases: readonly string[]): string[] {
  const alternation = [...phases].sort((left, right) => right.length - left.length).join("|");
  const literal = new RegExp(`"(${alternation})"`, "g");
  const order: string[] = [];
  for (const match of body.matchAll(literal)) {
    const phase = match[1];
    if (phase !== undefined && !order.includes(phase)) order.push(phase);
  }
  return order;
}

/** The doc comment that contains `marker`, from its opening `/**` to its closing `*``/`. */
function commentContaining(source: string, marker: string): string {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`commentContaining: marker not found: ${marker}`);
  const open = source.lastIndexOf("/**", at);
  const close = source.indexOf("*/", at);
  if (open < 0 || close < 0) throw new Error(`commentContaining: the marker is not inside a doc comment: ${marker}`);
  return source.slice(open, close + 2);
}

interface CommentVerdict {
  ok: boolean;
  /** The phases the comment names, in the order it names them. */
  named: string[];
  missing: string[];
  extra: string[];
  orderOk: boolean;
  /** `null` when the comment carries no numbering at all; otherwise the numbering must be a complete 1..n. */
  numberingOk: boolean | null;
}

/** What one comment says about the phases, measured against the vocabulary and the order read from the code. */
function checkComment(comment: string, phases: readonly string[], expectedOrder: readonly string[]): CommentVerdict {
  const tokens: string[] = [];
  for (const match of comment.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const token = match[0];
    if (token !== undefined) tokens.push(token);
  }
  const named: string[] = [];
  for (const token of tokens) {
    if (phases.includes(token) && !named.includes(token)) named.push(token);
  }
  const extra = [...new Set(tokens.filter((token) => token.includes("_") && !phases.includes(token)))];
  const numbered: { position: number; phase: string }[] = [];
  for (const match of comment.matchAll(/(\d+)\s+([a-z][a-z0-9_]*)/g)) {
    const phase = match[2];
    if (phase === undefined || !phases.includes(phase) || numbered.some((entry) => entry.phase === phase)) continue;
    numbered.push({ position: Number(match[1]), phase });
  }
  const missing = phases.filter((phase) => !named.includes(phase));
  const orderOk = named.length === expectedOrder.length && named.every((phase, index) => phase === expectedOrder[index]);
  const numberingOk = numbered.length === 0
    ? null
    : numbered.length === phases.length && numbered.every((entry, index) => entry.position === index + 1);
  return {
    ok: missing.length === 0 && extra.length === 0 && orderOk && numberingOk !== false,
    named,
    missing,
    extra,
    orderOk,
    numberingOk,
  };
}

/** The suites of the gate's fixed list, parsed out of the script's source rather than imported. */
function gateSuitesFromScript(source: string): string[] {
  const start = source.indexOf(GATE_ARRAY_MARKER);
  if (start < 0) throw new Error(`gateSuitesFromScript: ${GATE_ARRAY_MARKER} is gone`);
  const end = source.indexOf("\n];", start);
  if (end < 0) throw new Error("gateSuitesFromScript: the list is not terminated");
  const suites: string[] = [];
  for (const match of source.slice(start, end).matchAll(/^\s*"([^"]+)",\s*$/gm)) {
    const suite = match[1];
    if (suite !== undefined) suites.push(suite);
  }
  if (suites.length === 0) throw new Error("gateSuitesFromScript: the list parsed to nothing");
  return suites;
}

interface DocClaim {
  /** Which sentence of the document stated the number, so a failure names the place to fix. */
  shape: string;
  value: number;
}

/**
 * Every place the report states the current size of the gate, and every place it states how many listed
 * suites are missing. The shapes are named so that a failure says which sentence is stale, and a shape that
 * disappeared entirely is reported instead of quietly contributing no claim (a deleted sentence is a
 * document that no longer says anything, not a document that agrees).
 */
function documentedGateSizes(report: string): { sizeClaims: DocClaim[]; missingClaims: DocClaim[]; missingShapes: string[] } {
  const sizeClaims: DocClaim[] = [];
  const missingClaims: DocClaim[] = [];
  const missingShapes: string[] = [];
  const single = (shape: string, pattern: RegExp): void => {
    const match = pattern.exec(report);
    if (!match || match[1] === undefined) {
      missingShapes.push(shape);
      return;
    }
    sizeClaims.push({ shape, value: Number(match[1]) });
  };
  single("canonical sentence (Поточний розмір фіксованого списку гейта)", /Поточний розмір фіксованого списку гейта[^\n]*?\*\*(\d+)\*\*/);
  single("`--list` row", /`node scripts\/run-security-gate\.mjs --list`[^\n]*?\*\*(\d+)\*\*/);
  for (const match of report.matchAll(/→\s*\*\*(\d+)\*\*/g)) {
    // A bold number after an arrow is a *current* claim; the history (131 → 138) is deliberately not bold.
    if (match[1] !== undefined) sizeClaims.push({ shape: "bold number after an arrow", value: Number(match[1]) });
  }
  for (const match of report.matchAll(/suites=(\d+) present=(\d+) missing=(\d+)/g)) {
    if (match[1] !== undefined) sizeClaims.push({ shape: "suites=", value: Number(match[1]) });
    if (match[2] !== undefined) sizeClaims.push({ shape: "present=", value: Number(match[2]) });
    if (match[3] !== undefined) missingClaims.push({ shape: "missing=", value: Number(match[3]) });
  }
  return { sizeClaims, missingClaims, missingShapes };
}

const engineSource = readRepoFile(ENGINE_PATH);
const wiringSource = readRepoFile(WIRING_PATH);
const gateScriptSource = readRepoFile(GATE_SCRIPT_PATH);
const reportSource = readRepoFile(REPORT_PATH);

const PHASES: readonly string[] = policyPhases(engineSource);
const EXECUTION_BODY = methodBody(engineSource, ENGINE_SIGNATURE);
const EXECUTION_ORDER: readonly string[] = phaseExecutionOrder(EXECUTION_BODY, PHASES);
const ENGINE_COMMENT = commentContaining(engineSource, ENGINE_COMMENT_MARKER);
const WIRING_COMMENT = commentContaining(wiringSource, WIRING_COMMENT_MARKER);
const GATE_SUITES: readonly string[] = gateSuitesFromScript(gateScriptSource);
const GATE_SIZE = GATE_SUITES.length;

/** The two comments that describe the phase order, named by file so a failure says where to look. */
const COMMENTS: readonly { label: string; text: string }[] = [
  { label: `${ENGINE_PATH} header comment`, text: ENGINE_COMMENT },
  { label: `${WIRING_PATH} wiring comment`, text: WIRING_COMMENT },
];

describe("security-gate: C14 cleanup — the phase vocabulary and the phase order cannot drift apart", () => {
  it("the vocabulary is the union type, and every member of it is really reached in the engine", () => {
    // Anchors first: a slice that stopped early would compare fewer phases and could pass by accident.
    expect(EXECUTION_BODY.length).toBeGreaterThan(5_000);
    expect(EXECUTION_BODY).toContain("MODE_RISK_MATRIX");
    expect(EXECUTION_BODY).not.toContain("private async gitWriteIntentsFor");
    // A vocabulary read as one entry cannot be compared with anything, so it is a failure, not a pass.
    expect(PHASES.length).toBeGreaterThan(1);
    expect(PHASES.length).toBe(new Set(PHASES).size);
    expect(PHASES.filter((phase) => !/^[a-z][a-z0-9_]*$/.test(phase))).toEqual([]);
    // Both directions: a phase that never appears in the method, and a phase the method refuses under that
    // the union does not declare, are both a disagreement between the type and the code.
    expect([...EXECUTION_ORDER].sort()).toEqual([...PHASES].sort());
  });

  it("the engine's header comment names every phase, in execution order, with a complete numbering", () => {
    const verdict = checkComment(ENGINE_COMMENT, PHASES, EXECUTION_ORDER);
    expect(verdict.missing).toEqual([]);
    expect(verdict.extra).toEqual([]);
    expect(verdict.orderOk).toBe(true);
    expect(verdict.numberingOk).toBe(true);
    expect(verdict.ok).toBe(true);
  });

  it("the wiring comment in app.ts names every phase, in execution order", () => {
    const verdict = checkComment(WIRING_COMMENT, PHASES, EXECUTION_ORDER);
    expect(verdict.missing).toEqual([]);
    expect(verdict.extra).toEqual([]);
    expect(verdict.orderOk).toBe(true);
    expect(verdict.numberingOk).toBe(true);
    expect(verdict.ok).toBe(true);
  });

  it("the comment check is not vacuous: removing any one phase from a copy of either comment is reported", () => {
    const unreported: string[] = [];
    for (const comment of COMMENTS) {
      for (const phase of PHASES) {
        const mutated = comment.text.replace(new RegExp(`\\b${phase}\\b`, "g"), INVENTED_TOKEN);
        if (mutated === comment.text) {
          // Not a vacuous check but a broken input: the real comment does not name this phase at all, which is
          // the failure the suite above already reports. Say so here instead of comparing two identical texts.
          unreported.push(`${comment.label}: ${phase} is not named in the comment, so there was nothing to remove`);
          continue;
        }
        const verdict = checkComment(mutated, PHASES, EXECUTION_ORDER);
        if (verdict.ok || !verdict.missing.includes(phase) || verdict.orderOk || !verdict.extra.includes(INVENTED_TOKEN)) {
          unreported.push(
            `${comment.label}: dropping ${phase} was not reported ` +
              `(missing=${verdict.missing.join(",")} extra=${verdict.extra.join(",")} orderOk=${verdict.orderOk})`,
          );
        }
      }
    }
    expect(unreported).toEqual([]);
  });

  it("the order check is not vacuous: swapping two phases in a copy of either comment is reported", () => {
    const first = EXECUTION_ORDER[0];
    const second = EXECUTION_ORDER[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const unreported: string[] = [];
    for (const comment of COMMENTS) {
      const swapped = comment.text
        .replace(new RegExp(`\\b${first}\\b`, "g"), INVENTED_TOKEN)
        .replace(new RegExp(`\\b${second}\\b`, "g"), String(first))
        .replaceAll(INVENTED_TOKEN, String(second));
      const verdict = checkComment(swapped, PHASES, EXECUTION_ORDER);
      // The numbering stays a complete 1..n (the labels merely traded places), so the order check is what has
      // to report this: a guard that only read the numbers would pass a comment naming the phases backwards.
      if (verdict.ok || verdict.orderOk) {
        unreported.push(`${comment.label}: swapping the first two phases was not reported (orderOk=${verdict.orderOk})`);
      }
    }
    expect(unreported).toEqual([]);
  });
});

describe("security-gate: C14 cleanup — the report's suite count is read, not remembered", () => {
  it("the gate's list is parsed from the script and agrees with the module's own export", () => {
    expect(GATE_SUITES.length).toBeGreaterThan(100);
    expect(GATE_SUITES.length).toBe(SECURITY_GATE_TESTS.length);
    expect(GATE_SUITES.length).toBe(new Set(GATE_SUITES).size);
    expect(GATE_SUITES.filter((suite) => !suite.endsWith(".test.ts"))).toEqual([]);
  });

  it("every suite the list names exists on disk, which is what the report's `missing=0` claims", () => {
    expect(GATE_SUITES.filter((suite) => !existsSync(path.join(workspaceRoot, suite)))).toEqual([]);
  });

  it("the document states the current size in every place it states one, and it is the size of the list", () => {
    const parsed = documentedGateSizes(reportSource);
    // A shape that vanished is a document that stopped making the claim, so it is reported, not skipped.
    expect(parsed.missingShapes).toEqual([]);
    expect(parsed.sizeClaims.length).toBeGreaterThanOrEqual(4);
    expect(parsed.sizeClaims.filter((claim) => claim.value !== GATE_SIZE).map((claim) => `${claim.shape}=${claim.value}`)).toEqual([]);
    expect(parsed.missingClaims.filter((claim) => claim.value !== 0).map((claim) => `${claim.shape}=${claim.value}`)).toEqual([]);
  });

  it("the size check is not vacuous: a wrong number in a copy of the document is reported", () => {
    const real = documentedGateSizes(reportSource);
    expect(real.sizeClaims.filter((claim) => claim.value !== GATE_SIZE)).toEqual([]);

    // Every current-size number bumped by one: every claim must move with it, which proves the numbers come
    // from the document text and not from a constant in this file.
    const bumped = documentedGateSizes(reportSource.split(String(GATE_SIZE)).join(String(GATE_SIZE + 1)));
    expect(bumped.sizeClaims.length).toBe(real.sizeClaims.length);
    expect(bumped.sizeClaims.filter((claim) => claim.value !== GATE_SIZE + 1)).toEqual([]);

    // Only the pair inside the table broken: the shapes are read separately, so this is reported too.
    const brokenPair = documentedGateSizes(reportSource.replace(`suites=${GATE_SIZE} present=${GATE_SIZE}`, "suites=1 present=2"));
    expect(
      brokenPair.sizeClaims.filter((claim) => claim.shape === "suites=" || claim.shape === "present=").map((claim) => claim.value),
    ).toEqual([1, 2]);

    // The canonical sentence removed: a claim that is no longer made is a failure of its own shape.
    const removedSentence = documentedGateSizes(reportSource.replace("Поточний розмір фіксованого списку гейта", "Розмір гейта"));
    expect(removedSentence.missingShapes.length).toBeGreaterThan(0);
  });

  it("this guard keeps no copy of either fact: no phase name and no size is a literal of its own source", () => {
    const selfSource = readRepoFile(GUARD_PATH);
    const literals: string[] = [];
    for (const match of selfSource.matchAll(/"([^"\n]*)"/g)) {
      const literal = match[1];
      if (literal !== undefined) literals.push(literal);
    }
    expect(literals.filter((literal) => PHASES.includes(literal))).toEqual([]);
    const numbers: string[] = [];
    for (const match of selfSource.matchAll(/\b\d+\b/g)) numbers.push(match[0] ?? "");
    expect(numbers.filter((number) => number === String(GATE_SIZE))).toEqual([]);
  });
});
