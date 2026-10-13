import {
  SELF_REVIEW_FINDING_CATEGORIES,
  SELF_REVIEW_SEVERITIES,
} from "./code-self-review";
import {
  CODE_EVAL_SCHEMA_VERSION,
  CodeEvalError,
  EVAL_FIXTURE_MIN_SCHEMA_VERSION,
  EVAL_LANGUAGES,
  EVAL_TASK_KINDS,
  type EvalFixture,
  type EvalTask,
} from "./code-eval-harness-types";

const VERIFICATION_TYPES = new Set([
  "file_contains",
  "command_succeeds",
  "command_fails",
  "diff_stats",
  "test_integrity",
  "self_review",
  "repair_loop",
]);

function invalid(message: string, details?: Record<string, unknown>): CodeEvalError {
  return new CodeEvalError("eval_fixture_invalid", message, 400, details);
}

const CATEGORY_SET = new Set<string>(SELF_REVIEW_FINDING_CATEGORIES);
const SEVERITY_SET = new Set<string>(SELF_REVIEW_SEVERITIES);
/** The C14 coverage vocabularies, as sets, so a fixture typo is refused instead of counted as coverage. */
const TASK_KIND_SET = new Set<string>(EVAL_TASK_KINDS);
const LANGUAGE_SET = new Set<string>(EVAL_LANGUAGES);

/**
 * Rejects a malformed verification instead of skipping it. Every C9 kind is checked here as well, so a typo in
 * a fixture fails the suite loudly rather than producing a task that quietly verifies nothing.
 */
function validateVerification(value: unknown, where: string): void {
  if (!value || typeof value !== "object") throw invalid(`${where}: verification must be an object`);
  const raw = value as Record<string, unknown>;
  const type = typeof raw.type === "string" ? raw.type : "";
  if (!VERIFICATION_TYPES.has(type)) throw invalid(`${where}: unknown verification type '${String(raw.type)}'`);
  switch (type) {
    case "file_contains":
      if (typeof raw.path !== "string" || !raw.path || typeof raw.contains !== "string") {
        throw invalid(`${where}: file_contains needs a path and a contains string`);
      }
      return;
    case "command_succeeds":
    case "command_fails":
      if (typeof raw.command !== "string" || !raw.command) throw invalid(`${where}: ${type} needs a command`);
      return;
    case "diff_stats": {
      const expected = raw.expect;
      if (!expected || typeof expected !== "object") throw invalid(`${where}: diff_stats needs an expect object`);
      const numbers = expected as Record<string, unknown>;
      // `files` is required even when it is zero, so "the change set is exactly this" can never be satisfied
      // by leaving the field out — the shape a task would use to make a wrong change set pass.
      if (typeof numbers.files !== "number" || !Number.isInteger(numbers.files) || numbers.files < 0) {
        throw invalid(`${where}: diff_stats needs a non-negative integer files count`);
      }
      for (const key of ["linesAdded", "linesRemoved"]) {
        const value = numbers[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
          throw invalid(`${where}: diff_stats ${key} must be a non-negative integer when present`);
        }
      }
      return;
    }
    case "test_integrity":
      if (raw.expect !== "flagged" && raw.expect !== "clean") throw invalid(`${where}: test_integrity expect must be flagged or clean`);
      if (raw.kinds !== undefined && (!Array.isArray(raw.kinds) || raw.kinds.some((kind) => typeof kind !== "string"))) {
        throw invalid(`${where}: test_integrity kinds must be an array of finding kinds`);
      }
      return;
    case "self_review": {
      if (typeof raw.answer !== "string" || !raw.answer) throw invalid(`${where}: self_review needs a recorded answer`);
      if (!Array.isArray(raw.expect) || !raw.expect.length) throw invalid(`${where}: self_review needs at least one expected finding`);
      for (const entry of raw.expect) {
        if (!entry || typeof entry !== "object") throw invalid(`${where}: self_review expectations must be objects`);
        const expected = entry as Record<string, unknown>;
        if (typeof expected.category !== "string" || !CATEGORY_SET.has(expected.category)) {
          throw invalid(`${where}: unknown self_review finding category '${String(expected.category)}'`);
        }
        if (expected.severity !== undefined && (typeof expected.severity !== "string" || !SEVERITY_SET.has(expected.severity))) {
          throw invalid(`${where}: unknown self_review severity '${String(expected.severity)}'`);
        }
        if (expected.file !== undefined && expected.file !== null && typeof expected.file !== "string") {
          throw invalid(`${where}: self_review expectation file must be a path or null`);
        }
      }
      return;
    }
    case "repair_loop": {
      const expected = (raw.expect ?? {}) as Record<string, unknown>;
      if (typeof raw.maxAttempts !== "number" || !Number.isInteger(raw.maxAttempts) || raw.maxAttempts < 0) {
        throw invalid(`${where}: repair_loop needs a non-negative integer maxAttempts`);
      }
      if (typeof expected.repairs !== "number" || !Number.isInteger(expected.repairs) || expected.repairs < 0) {
        throw invalid(`${where}: repair_loop needs an expected repair count`);
      }
      if (expected.stopCode !== undefined && typeof expected.stopCode !== "string") {
        throw invalid(`${where}: repair_loop stopCode must be a string when present`);
      }
      return;
    }
  }
}

function validateStep(value: unknown, where: string): void {
  if (!value || typeof value !== "object") throw invalid(`${where}: step must be an object`);
  const step = value as Record<string, unknown>;
  if (step.kind === "message") {
    if (typeof step.text !== "string") throw invalid(`${where}: a message step needs text`);
    return;
  }
  if (step.kind === "tool") {
    if (typeof step.tool !== "string" || !step.tool) throw invalid(`${where}: a tool step needs a tool name`);
    return;
  }
  if (step.kind === "check") {
    if (typeof step.command !== "string" || !step.command) throw invalid(`${where}: a check step needs a command`);
    if (step.expect !== "pass" && step.expect !== "fail") throw invalid(`${where}: a check step needs expect pass or fail`);
    return;
  }
  throw invalid(`${where}: unknown step kind '${String(step.kind)}'`);
}

/**
 * Loads an already parsed fixture set and rejects malformed tasks instead of skipping them silently.
 * A schema-1 task stays valid here by construction: every C9 kind is optional and additive.
 */
export function loadEvalTasks(raw: unknown): EvalTask[] {
  if (!Array.isArray(raw)) throw new CodeEvalError("eval_fixture_invalid", "Eval fixture must be an array of tasks", 400);
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new CodeEvalError("eval_fixture_invalid", `Task #${index} is not an object`, 400);
    const task = entry as Partial<EvalTask>;
    if (!task.id || !task.title || !task.intent || !task.files || !Array.isArray(task.script) || !task.verify) {
      throw new CodeEvalError("eval_fixture_invalid", `Task #${index} is missing required fields`, 400, { id: task.id });
    }
    const where = `Task ${task.id}`;
    task.script.forEach((step, stepIndex) => validateStep(step, `${where} step #${stepIndex}`));
    const verifications = Array.isArray(task.verify) ? task.verify : [task.verify];
    if (!verifications.length) throw invalid(`${where} declares no verification`);
    verifications.forEach((verification, verificationIndex) => validateVerification(verification, `${where} verification #${verificationIndex}`));
    if (task.goal !== undefined && typeof task.goal !== "string") throw invalid(`${where}: goal must be a string when present`);
    // C14: both are optional (a schema-1/2 task stays valid verbatim) but a *present* value must be from the
    // closed vocabulary — a typo would otherwise be counted as coverage for a kind nothing covers.
    if (task.taskType !== undefined && !TASK_KIND_SET.has(task.taskType)) {
      throw invalid(`${where}: unknown taskType '${String(task.taskType)}'`);
    }
    if (task.language !== undefined && !LANGUAGE_SET.has(task.language)) {
      throw invalid(`${where}: unknown language '${String(task.language)}'`);
    }
    if (task.maxSteps !== undefined && (typeof task.maxSteps !== "number" || !Number.isInteger(task.maxSteps) || task.maxSteps < 1)) {
      throw invalid(`${where}: maxSteps must be a positive integer when present`);
    }
    return task as EvalTask;
  });
}

/**
 * Loads a whole fixture, including its version. A fixture written for a NEWER schema is refused instead of
 * being read with the fields this build happens to understand — the failure mode that silently drops a
 * verification is worse than a load error. An older fixture keeps working, which is the point of versioning
 * the format additively.
 */
export function loadEvalFixture(raw: unknown): EvalFixture {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CodeEvalError("eval_fixture_invalid", "Eval fixture must be an object with a schemaVersion and tasks", 400);
  }
  const fixture = raw as { schemaVersion?: unknown; description?: unknown; tasks?: unknown };
  const version = fixture.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new CodeEvalError("eval_fixture_invalid", "Eval fixture must declare an integer schemaVersion", 400);
  }
  if (version < EVAL_FIXTURE_MIN_SCHEMA_VERSION || version > CODE_EVAL_SCHEMA_VERSION) {
    throw new CodeEvalError("eval_fixture_version_unsupported", `Eval fixture schemaVersion ${version} is not supported`, 400, {
      supported: [EVAL_FIXTURE_MIN_SCHEMA_VERSION, CODE_EVAL_SCHEMA_VERSION],
    });
  }
  return {
    schemaVersion: version,
    ...(typeof fixture.description === "string" ? { description: fixture.description } : {}),
    tasks: loadEvalTasks(fixture.tasks),
  };
}
