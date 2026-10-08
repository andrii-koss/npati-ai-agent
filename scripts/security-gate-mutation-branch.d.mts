/**
 * Types for `scripts/security-gate-mutation-branch.mjs`, so the mutation-branch suite can be part of
 * `npm run typecheck:tests` (the same pattern `scripts/run-security-gate.d.mts` uses for the gate).
 *
 * The transcript, the artifact and the matrix rows are `unknown` on purpose: the transcript is a process's
 * output and the artifact is a JSON file, so both are external input and the readers defend themselves against
 * a shape they do not recognise instead of trusting a declaration.
 */

export declare const MUTATION_ARTIFACT_PATH: string;
export declare const MUTATION_EVIDENCE_DIRECTORY: string;

export interface GateTranscriptEvidence {
  ok: boolean;
  path: string;
  bytes: number;
  error: string | null;
}

export interface GateTestsTotals {
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
}

export interface GateFailingTest {
  file: string;
  title: string;
}

export interface GateTranscript {
  measured: boolean;
  tests: GateTestsTotals | null;
  failedTests: GateFailingTest[];
  verdict: string | null;
  environmentLines: string[];
}

export interface GateFailureMessage extends GateFailingTest {
  message: string[];
}

export interface GateRunObservation {
  status: number | null;
  signal: string | null;
  spawnError: string | null;
  measured: boolean;
  tests: GateTestsTotals | null;
  failedTests: GateFailingTest[];
  observed: string[];
  verdict: string | null;
  environmentLines: string[];
  suiteLines: string[];
  failureMessages: GateFailureMessage[];
}

export interface GateRunVerdict {
  measured: boolean;
  tests: GateTestsTotals | null;
  failedTests: GateFailingTest[];
  observed: string[];
  newFailures: string[];
  preExistingFailures: string[];
  suiteLines: string[];
  exitCode: number | null;
  expectedGateExit: unknown;
  verdict: string;
  reason: string;
}

export interface GateIgnoredResourceConsumer {
  file: string;
  evidence: string;
}

export interface GateIgnoredResource {
  path: string;
  kind: string;
  reason: string;
  consumers: GateIgnoredResourceConsumer[];
}

export interface MirroredIgnoredResource {
  path: string;
  mode: string;
  files: number;
}

export interface RepositoryState {
  status: string;
  worktrees: string;
}

export declare const GATE_IGNORED_RESOURCES: GateIgnoredResource[];

export declare function mutationTranscriptPath(label: unknown): string;
export declare function writeGateTranscript(root: string, label: unknown, transcript: unknown): GateTranscriptEvidence;
export declare function parseGateTranscript(transcript: unknown): GateTranscript;
export declare function parseFailureMessages(
  transcript: unknown,
  options?: { maxPerTest?: number; maxTests?: number },
): GateFailureMessage[];
export declare function parseSuiteLines(transcript: unknown): string[];
export declare function failureTitleMatches(observedTitle: unknown, expectedTitle: unknown): boolean;
export declare function normalizeSuite(value: unknown): string;
export declare function readGateArtifact(worktree: string): unknown;
export declare function failedTestsFromArtifact(artifact: unknown): GateFailingTest[];
export declare function observeGateRun(input: {
  status?: number | null;
  signal?: string | null;
  spawnError?: string | null;
  transcript?: unknown;
  artifact?: unknown;
}): GateRunObservation;
export declare function isGateRunObservation(value: unknown): boolean;
export declare function baselineProblem(baseline: GateRunObservation | null | undefined): string | null;
export declare function classifyGateRun(input: {
  kind?: string;
  expectedGateExit?: unknown;
  expectedFailingSuite?: string | null;
  expectedFailingTest?: string | null;
  status?: number | null;
  signal?: string | null;
  spawnError?: string | null;
  transcript?: unknown;
  artifact?: unknown;
  baseline?:
    | {
        status?: number | null;
        signal?: string | null;
        spawnError?: string | null;
        transcript?: unknown;
        artifact?: unknown;
      }
    | GateRunObservation
    | null;
}): GateRunVerdict;
export declare function snapshotRepositoryState(root: string): RepositoryState;
export declare function mirrorWorkingTree(
  root: string,
  worktree: string,
  log?: (line: string) => void,
): { copied: string[]; deleted: string[]; untracked: string[] };
export declare function isIgnoredPath(root: string, relativePath: string): boolean;
export declare function mirrorResourceDirectory(
  source: string,
  target: string,
  log?: (line: string) => void,
): { copied: string[]; created: boolean };
export declare function mirrorIgnoredResources(
  root: string,
  worktree: string,
  log?: (line: string) => void,
): MirroredIgnoredResource[];
export declare function linkNodeModules(
  root: string,
  worktree: string,
  log?: (line: string) => void,
): { linked: boolean; reason: string | null };
export declare function declaredSubmodules(source: unknown): string[];
export declare function linkSubmodules(
  root: string,
  worktree: string,
  log?: (line: string) => void,
): { linked: string[]; skipped: string[]; declared: string[] };
export declare function unlinkJunctions(
  root: string,
  worktree: string,
  relativePaths: readonly string[],
  log?: (line: string) => void,
): { removed: string[]; intact: boolean };
export declare function unlinkNodeModules(
  root: string,
  worktree: string,
  log?: (line: string) => void,
): { removed: string[]; intact: boolean };
