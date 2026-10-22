import { createHash } from "node:crypto";
import { LOCKFILES } from "./code-deps-policy";

/**
 * Step 2 — which of the requested checks a change set actually needs.
 *
 * `code.verify.run` has always accepted `changedOnly`, but the runner port never received a file list, so the
 * flag could not narrow anything: every call ran every requested command. This module is the missing decision,
 * and it is deliberately **pure**: it reads paths, not the workspace, so the same change set always produces the
 * same plan and a test can assert it without a sandbox.
 *
 * The rule is conservative on purpose. Only a change set made **exclusively of stylesheets and assets** may drop
 * the project's test command; everything else — source, tests, dependencies, config, unknown files, or an empty
 * change set — keeps the full requested list. `build` is never dropped: a stylesheet still has to compile, and
 * the production Live Preview gate requires build evidence.
 */

/** Bump when the selection rules change: it is part of the verification reuse fingerprint. */
export const VERIFICATION_PLAN_VERSION = 1;

export type VerificationChangeKind = "dependency" | "test" | "style" | "asset" | "source" | "unknown";

export interface VerificationSkip {
  tool: string;
  /** Machine-readable reason, never free text: it is persisted in the run summary. */
  reason: "presentation_only_change";
}

export interface VerificationPlan {
  version: typeof VERIFICATION_PLAN_VERSION;
  /** The checks to run, in the caller's order. Always a subset of the requested list. */
  tools: string[];
  skipped: VerificationSkip[];
  changeKinds: VerificationChangeKind[];
  reason: "no_changes" | "significant_change" | "presentation_only";
}

const STYLE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less", ".styl", ".stylus"]);

const ASSET_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".vue", ".svelte", ".astro", ".py", ".rb", ".php", ".go", ".rs", ".java", ".kt", ".kts",
  ".cs", ".swift", ".dart", ".scala", ".ex", ".exs", ".html", ".htm", ".hbs", ".ejs", ".pug",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".env", ".xml", ".sql", ".graphql", ".gql",
  ".md", ".mdx", ".txt", ".sh", ".bash", ".ps1", ".tf",
]);

/**
 * Dependency manifests and lockfiles. The lockfile names are reused from the dependency policy so the two
 * modules cannot disagree about which file declares the dependency graph.
 */
const DEPENDENCY_FILES = new Set([
  "package.json", "requirements.txt", "pyproject.toml", "uv.lock", "poetry.lock", "Pipfile", "Pipfile.lock",
  "composer.json", "composer.lock", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "Gemfile", "Gemfile.lock",
  "pom.xml", "build.gradle", "build.gradle.kts",
  ...Object.values(LOCKFILES),
]);

function baseName(filePath: string): string {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? normalized;
}

function extensionOf(base: string): string {
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** Classifies one changed path. An unrecognised file is `unknown`, which forces the full requested set. */
export function classifyVerificationChange(filePath: string): VerificationChangeKind {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  if (!normalized.trim()) return "unknown";
  const base = baseName(normalized);
  if (DEPENDENCY_FILES.has(base) || base.toLowerCase().endsWith(".lock")) return "dependency";
  if (/(^|\/)(__tests__|test|tests|spec|specs|e2e)(\/|$)/i.test(normalized) || /\.(test|spec)\.[a-z0-9]+$/i.test(base)) {
    return "test";
  }
  const extension = extensionOf(base);
  if (STYLE_EXTENSIONS.has(extension)) return "style";
  if (ASSET_EXTENSIONS.has(extension)) return "asset";
  if (SOURCE_EXTENSIONS.has(extension)) return "source";
  return "unknown";
}

/**
 * Chooses the checks to run.
 *
 * - `no_changes` — nothing was changed (or nothing was requested), so no narrowing is justified and every
 *   requested check runs. A caller that has already proven "no changes" skips verification before calling here.
 * - `presentation_only` — every changed file is a stylesheet or an asset. The project's test command cannot
 *   observe those files, so `test` is dropped **only if at least one other check remains** and `build` (when
 *   requested) is kept.
 * - `significant_change` — anything else keeps the full requested list.
 */
export function planVerification(input: {
  requestedTools: readonly string[];
  changedPaths: readonly string[];
}): VerificationPlan {
  const requested = [...new Set(input.requestedTools.map((tool) => String(tool ?? "").trim().toLowerCase()).filter(Boolean))];
  const changedPaths = [...new Set(input.changedPaths.map((path) => String(path ?? "")).filter((path) => path.trim().length > 0))];

  if (!requested.length) {
    return { version: VERIFICATION_PLAN_VERSION, tools: [], skipped: [], changeKinds: [], reason: "no_changes" };
  }
  if (!changedPaths.length) {
    return { version: VERIFICATION_PLAN_VERSION, tools: requested, skipped: [], changeKinds: [], reason: "no_changes" };
  }

  const changeKinds = [...new Set(changedPaths.map(classifyVerificationChange))];
  const presentationOnly = changeKinds.every((kind) => kind === "style" || kind === "asset");
  if (!presentationOnly) {
    return { version: VERIFICATION_PLAN_VERSION, tools: requested, skipped: [], changeKinds, reason: "significant_change" };
  }

  const tools = requested.filter((tool) => tool !== "test");
  if (!tools.length) {
    // The test command is the only gate this project has; narrowing would leave nothing to prove the change.
    return { version: VERIFICATION_PLAN_VERSION, tools: requested, skipped: [], changeKinds, reason: "significant_change" };
  }
  return {
    version: VERIFICATION_PLAN_VERSION,
    tools,
    skipped: requested.includes("test") ? [{ tool: "test", reason: "presentation_only_change" }] : [],
    changeKinds,
    reason: "presentation_only",
  };
}

/**
 * Identity of one verification result. A cached result may be reused only for the same canonical revision, the
 * same executed checks, the same execution image and the same run change signature — and the plan version is
 * part of the digest so a change to the selection rules cannot reuse an older decision.
 *
 * The canonical revision is a digest over the workspace file set, so it also covers configuration and dependency
 * files: editing `package.json` or a lockfile moves the revision and invalidates every cached result.
 */
export function verificationFingerprint(input: {
  revision: string;
  tools: readonly string[];
  sandboxImage?: string | null;
  changeSignature?: string | null;
}): string {
  const material = JSON.stringify({
    version: VERIFICATION_PLAN_VERSION,
    revision: input.revision,
    tools: [...input.tools].map((tool) => tool.toLowerCase()).sort(),
    image: input.sandboxImage ?? "unknown",
    changes: input.changeSignature ?? "",
  });
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}
