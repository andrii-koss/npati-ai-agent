/**
 * C4a: sensitive-change guard.
 *
 * Some files change what the project *executes* rather than what it says: lifecycle scripts run on
 * install, CI workflows run with repository credentials, Dockerfiles and hooks run on every clone. These
 * changes must never pass automatically in any agent mode — a human decides.
 */

export type PolicyMode = "plan" | "ask" | "auto_edit" | "full_auto_sandbox";
/** Modes in which a sensitive change must be approved; `plan` denies such changes anyway. */
export type SensitiveApprovalMode = Exclude<PolicyMode, "plan">;

export interface SensitiveChangeVerdict {
  path: string;
  sensitive: boolean;
  reasons: string[];
  requiresApprovalInModes: SensitiveApprovalMode[];
}

const ALL_APPROVAL_MODES: SensitiveApprovalMode[] = ["ask", "auto_edit", "full_auto_sandbox"];

const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack", "prepublish", "prepublishOnly"];

const SHELL_IN_SCRIPT = /(curl|wget|fetch)\s[^|;]*\|\s*(sh|bash|zsh)|(?:^|[^A-Za-z])(?:sh|bash|zsh)\s+-c\s|node\s+-e\s|python[0-9.]*\s+-c\s|eval\s/i;

/**
 * Maps the session modes used by the C1 `CodeSession` schema onto the policy modes approved for the
 * matrix, so both spellings behave identically (`edit` is the "ask" mode, `auto` is `auto_edit`).
 */
export function normalizePolicyMode(mode: string | undefined): PolicyMode | undefined {
  switch (mode) {
    case "plan": return "plan";
    case "ask":
    case "edit": return "ask";
    case "auto_edit":
    case "auto": return "auto_edit";
    case "full_auto_sandbox":
    case "full_auto": return "full_auto_sandbox";
    default: return undefined;
  }
}

function parseJson(text: string | undefined): Record<string, any> | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

function packageJsonScriptFindings(before: string | undefined, after: string | undefined): string[] {
  const reasons: string[] = [];
  const beforeScripts = parseJson(before)?.scripts ?? {};
  const afterScripts = parseJson(after)?.scripts ?? {};
  for (const key of LIFECYCLE_SCRIPTS) {
    if (afterScripts[key] !== undefined && afterScripts[key] !== beforeScripts[key]) reasons.push(`lifecycle_script:${key}`);
  }
  for (const [key, value] of Object.entries(afterScripts as Record<string, unknown>)) {
    if (beforeScripts[key] === value) continue;
    if (typeof value === "string" && SHELL_IN_SCRIPT.test(value) && !LIFECYCLE_SCRIPTS.includes(key)) {
      reasons.push(`script_downloads_and_executes:${key}`);
    }
  }
  return reasons;
}

function makefileTargets(content: string | undefined): Set<string> {
  const targets = new Set<string>();
  if (!content) return targets;
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.\-/]+)\s*:(?!=)/.exec(line);
    if (match) targets.add(match[1]!);
  }
  return targets;
}

function tomlSourcesChanged(before: string | undefined, after: string | undefined): boolean {
  // Poetry and uv declare extra indexes as TOML tables (`[[tool.poetry.source]]`, `[tool.uv.index]`),
  // whose contents never start with `sources`/`index-url`, so the table itself is tracked as well.
  // Missing that would let a diff add a private index without being treated as a sensitive change.
  const extract = (text: string | undefined) => {
    const collected: string[] = [];
    let inSourceTable = false;
    for (const rawLine of (text ?? "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("[")) {
        inSourceTable = /^\[\[?tool\.(?:poetry|uv)\.(?:source|index|sources|repositories)/i.test(line);
        if (inSourceTable) collected.push(line);
        continue;
      }
      if (inSourceTable) { collected.push(line); continue; }
      if (/^(?:sources|index-url|extra-index-url|registry)\b/i.test(line)) collected.push(line);
    }
    return collected.join("\n");
  };
  return extract(before) !== extract(after);
}

function composerRepositoriesChanged(before: string | undefined, after: string | undefined): boolean {
  return JSON.stringify(parseJson(before)?.repositories ?? null) !== JSON.stringify(parseJson(after)?.repositories ?? null);
}

const WORKFLOW_PATTERN = /(^|\/)\.github\/workflows\/.+\.ya?ml$/i;
const DOCKERFILE_PATTERN = /(^|\/)(Dockerfile|Containerfile)(\.[A-Za-z0-9_.-]+)?$/i;
const GIT_HOOK_PATTERN = /(^|\/)(\.git\/hooks\/|\.husky\/)/i;
const NPMRC_PATTERN = /(^|\/)\.npmrc$/i;
const YARNRC_PATTERN = /(^|\/)\.yarnrc(\.yml)?$/i;
const PIP_CONF_PATTERN = /(^|\/)pip\.conf$/i;

/**
 * Classifies a single file change. `before`/`after` are the file contents when available; for a new file
 * pass only `after`, for a deletion only `before`.
 */
export function classifySensitiveChange(path: string, before?: string, after?: string): SensitiveChangeVerdict {
  const normalized = (path ?? "").replace(/\\/g, "/");
  const reasons: string[] = [];

  if (WORKFLOW_PATTERN.test(normalized)) reasons.push("ci_workflow");
  if (DOCKERFILE_PATTERN.test(normalized)) reasons.push("dockerfile");
  if (GIT_HOOK_PATTERN.test(normalized)) reasons.push("git_hook");
  if (NPMRC_PATTERN.test(normalized)) reasons.push("npm_config");
  if (YARNRC_PATTERN.test(normalized)) reasons.push("yarn_config");
  if (PIP_CONF_PATTERN.test(normalized)) reasons.push("pip_config");

  if (/(^|\/)package\.json$/i.test(normalized)) reasons.push(...packageJsonScriptFindings(before, after));
  if (/(^|\/)Makefile$/i.test(normalized)) {
    const beforeTargets = makefileTargets(before);
    const afterTargets = makefileTargets(after);
    const added = [...afterTargets].filter((target) => !beforeTargets.has(target));
    // A changed recipe is not visible without a diff, so any Makefile change with new targets or a
    // changed body is treated as sensitive; the caller passes the diff-derived bodies when available.
    if (added.length || (before !== undefined && after !== undefined && before !== after)) {
      reasons.push(...(added.length ? added.slice(0, 5).map((target) => `make_target:${target}`) : ["makefile_changed"]));
    }
  }
  if (/(^|\/)pyproject\.toml$/i.test(normalized) && tomlSourcesChanged(before, after)) reasons.push("python_sources_changed");
  if (/(^|\/)composer\.json$/i.test(normalized) && composerRepositoriesChanged(before, after)) reasons.push("composer_repositories_changed");

  const sensitive = reasons.length > 0;
  return {
    path: normalized,
    sensitive,
    reasons: sensitive ? reasons : ["not_sensitive"],
    requiresApprovalInModes: sensitive ? [...ALL_APPROVAL_MODES] : [],
  };
}

/** Batched variant: any sensitive file makes the whole change set sensitive. */
export function classifySensitiveChanges(files: Array<{ path: string; before?: string; after?: string }>): {
  sensitive: boolean;
  files: SensitiveChangeVerdict[];
  reasons: string[];
} {
  const verdicts = files.map((file) => classifySensitiveChange(file.path, file.before, file.after));
  const sensitiveFiles = verdicts.filter((verdict) => verdict.sensitive);
  return {
    sensitive: sensitiveFiles.length > 0,
    files: verdicts,
    reasons: sensitiveFiles.flatMap((verdict) => verdict.reasons.map((reason) => `${verdict.path}:${reason}`)),
  };
}

/**
 * A sensitive change requires approval in every non-plan mode, including `full_auto_sandbox`; only
 * `plan` is different, and there the change is denied outright by the policy engine.
 */
export function sensitiveChangeRequiresApproval(mode: string | undefined, verdict: SensitiveChangeVerdict): boolean {
  if (!verdict.sensitive) return false;
  const policyMode = normalizePolicyMode(mode);
  if (!policyMode || policyMode === "plan") return true;
  return verdict.requiresApprovalInModes.includes(policyMode);
}
