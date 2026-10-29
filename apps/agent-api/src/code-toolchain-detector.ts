import type { CodeToolchain, CodeVerifyCommands } from "@npati/workspace";

/**
 * C1: toolchain detection.
 *
 * Pure functions over a map of workspace files so detection is unit-testable without a sandbox and
 * identical for managed workspaces, git clones and (later, C15) mounted folders. The result is
 * stored as project metadata and can be corrected by the owner, so detection must never be
 * destructive: it only proposes commands and records the files that produced them.
 */

export interface ToolchainDetectionInput {
  /** Workspace-relative path -> text content (only manifest-like files are needed). */
  files: Record<string, string | undefined>;
}

export interface ToolchainDetection extends Omit<CodeToolchain, "detectedAt" | "source"> {
  languages: string[];
  packageManagers: string[];
  verifyCommands: CodeVerifyCommands;
  evidence: string[];
}

type PackageManager = "npm" | "pnpm" | "yarn";

function parseJson(content?: string): Record<string, unknown> | undefined {
  if (!content) return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function scriptsOf(manifest?: Record<string, unknown>): Record<string, string> {
  const scripts = manifest?.scripts;
  if (!scripts || typeof scripts !== "object") return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

function hasTarget(content: string | undefined, target: string): boolean {
  if (!content) return false;
  return new RegExp(`^${target}\\s*:`, "m").test(content);
}

function detectNode(files: Record<string, string | undefined>, evidence: string[]): Partial<ToolchainDetection> {
  const manifest = parseJson(files["package.json"]);
  if (!manifest) return {};
  evidence.push("package.json");
  let manager: PackageManager = "npm";
  if (files["pnpm-lock.yaml"]) { manager = "pnpm"; evidence.push("pnpm-lock.yaml"); }
  else if (files["yarn.lock"]) { manager = "yarn"; evidence.push("yarn.lock"); }
  else if (files["package-lock.json"]) { manager = "npm"; evidence.push("package-lock.json"); }
  const scripts = scriptsOf(manifest);
  const commands: CodeVerifyCommands = {};
  if (scripts.test) commands.test = `${manager} test`;
  if (scripts.lint) commands.lint = manager === "npm" ? "npm run lint" : `${manager} lint`;
  if (scripts.typecheck) commands.typecheck = manager === "npm" ? "npm run typecheck" : `${manager} typecheck`;
  else if (files["tsconfig.json"]) { commands.typecheck = "npx tsc --noEmit"; evidence.push("tsconfig.json"); }
  if (scripts.build) commands.build = manager === "npm" ? "npm run build" : `${manager} build`;
  const languages = ["node"];
  if (files["tsconfig.json"] || Object.values(scripts).some((value) => /tsc|typescript/.test(value))) languages.push("typescript");
  return { languages, packageManagers: [manager], verifyCommands: commands };
}

function detectPython(files: Record<string, string | undefined>, evidence: string[]): Partial<ToolchainDetection> {
  const managers: string[] = [];
  const commands: CodeVerifyCommands = {};
  if (files["uv.lock"] || /\[tool\.uv\]/.test(files["pyproject.toml"] ?? "")) { managers.push("uv"); evidence.push(files["uv.lock"] ? "uv.lock" : "pyproject.toml"); }
  if (/\[tool\.poetry\]/.test(files["pyproject.toml"] ?? "") || files["poetry.lock"]) { managers.push("poetry"); evidence.push(files["poetry.lock"] ? "poetry.lock" : "pyproject.toml"); }
  if (!managers.length && (files["pyproject.toml"] !== undefined || files["requirements.txt"] !== undefined)) {
    managers.push("pip");
    evidence.push(files["pyproject.toml"] ? "pyproject.toml" : "requirements.txt");
  }
  if (!managers.length) return {};
  const hasPytest = Boolean(files["pytest.ini"] !== undefined || files["tests/__init__.py"] !== undefined || /pytest/.test(files["pyproject.toml"] ?? "") || /pytest/.test(files["requirements.txt"] ?? "") || /\[tool:pytest\]/.test(files["setup.cfg"] ?? ""));
  if (hasPytest) commands.test = "python -m pytest";
  if (/\[tool\.ruff\]/.test(files["pyproject.toml"] ?? "") || files["ruff.toml"] || files[".ruff.toml"]) { commands.lint = "python -m ruff check ."; evidence.push("ruff.toml"); }
  if (/\[tool\.mypy\]/.test(files["pyproject.toml"] ?? "") || files["mypy.ini"]) { commands.typecheck = "python -m mypy ."; evidence.push("mypy.ini"); }
  return { languages: ["python"], packageManagers: managers, verifyCommands: commands };
}

function detectGo(files: Record<string, string | undefined>, evidence: string[]): Partial<ToolchainDetection> {
  if (!files["go.mod"]) return {};
  evidence.push("go.mod");
  const commands: CodeVerifyCommands = { test: "go test ./...", build: "go build ./..." };
  if (files[".golangci.yml"] || files[".golangci.yaml"]) { commands.lint = "golangci-lint run"; evidence.push(".golangci.yml"); }
  return { languages: ["go"], packageManagers: ["go"], verifyCommands: commands };
}

function detectRust(files: Record<string, string | undefined>, evidence: string[]): Partial<ToolchainDetection> {
  if (!files["Cargo.toml"]) return {};
  evidence.push("Cargo.toml");
  return {
    languages: ["rust"], packageManagers: ["cargo"],
    verifyCommands: { test: "cargo test", build: "cargo build", lint: "cargo clippy -- -D warnings" },
  };
}

function detectJava(files: Record<string, string | undefined>, evidence: string[]): Partial<ToolchainDetection> {
  if (files["pom.xml"]) {
    evidence.push("pom.xml");
    return { languages: ["java"], packageManagers: ["maven"], verifyCommands: { test: "mvn -q test", build: "mvn -q -DskipTests package" } };
  }
  if (files["build.gradle"] || files["build.gradle.kts"]) {
    evidence.push(files["build.gradle"] ? "build.gradle" : "build.gradle.kts");
    const wrapper = files["gradlew"] ? "./gradlew" : "gradle";
    return { languages: ["java"], packageManagers: ["gradle"], verifyCommands: { test: `${wrapper} test`, build: `${wrapper} build` } };
  }
  return {};
}

function detectPhp(files: Record<string, string | undefined>, evidence: string[]): Partial<ToolchainDetection> {
  const manifest = parseJson(files["composer.json"]);
  if (!manifest) return {};
  evidence.push("composer.json");
  const scripts = scriptsOf(manifest);
  const commands: CodeVerifyCommands = {};
  if (scripts.test) commands.test = "composer test";
  if (scripts.lint) commands.lint = "composer lint";
  return { languages: ["php"], packageManagers: ["composer"], verifyCommands: commands };
}

function detectFlutter(files: Record<string, string | undefined>, evidence: string[]): Partial<ToolchainDetection> {
  if (!/\bflutter\s*:/m.test(files["pubspec.yaml"] ?? "")) return {};
  evidence.push("pubspec.yaml");
  return { languages: ["dart"], packageManagers: ["pub"], verifyCommands: { lint: "flutter analyze", test: "flutter test" } };
}
const DETECTORS = [detectNode, detectPython, detectGo, detectRust, detectJava, detectPhp, detectFlutter];

/**
 * Detects languages, package managers and verify commands from manifest files.
 * `codes` are only filled when nothing more specific was found, and the Makefile never overrides a
 * package-manager script (an explicit script is more precise than a Makefile target).
 */
export function detectToolchain(input: ToolchainDetectionInput): ToolchainDetection {
  const files = input.files;
  const evidence: string[] = [];
  const languages = new Set<string>();
  const packageManagers = new Set<string>();
  const verifyCommands: CodeVerifyCommands = {};

  for (const detect of DETECTORS) {
    const partial = detect(files, evidence);
    for (const language of partial.languages ?? []) languages.add(language);
    for (const manager of partial.packageManagers ?? []) packageManagers.add(manager);
    for (const [key, value] of Object.entries(partial.verifyCommands ?? {})) {
      if (value && !verifyCommands[key as keyof CodeVerifyCommands]) verifyCommands[key as keyof CodeVerifyCommands] = value;
    }
  }

  const makefile = files["Makefile"];
  if (makefile) {
    evidence.push("Makefile");
    if (!verifyCommands.test && hasTarget(makefile, "test")) verifyCommands.test = "make test";
    if (!verifyCommands.lint && hasTarget(makefile, "lint")) verifyCommands.lint = "make lint";
    if (!verifyCommands.build && hasTarget(makefile, "build")) verifyCommands.build = "make build";
    if (!verifyCommands.typecheck && hasTarget(makefile, "typecheck")) verifyCommands.typecheck = "make typecheck";
  }

  return {
    languages: [...languages].sort(),
    packageManagers: [...packageManagers].sort(),
    verifyCommands,
    evidence: [...new Set(evidence)].sort(),
  };
}

/** Manifest files the workspace reader should load before calling `detectToolchain`. */
export const TOOLCHAIN_MANIFEST_FILES: readonly string[] = [
  "pubspec.yaml",
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json",
  "pyproject.toml", "requirements.txt", "poetry.lock", "uv.lock", "pytest.ini", "tests/__init__.py", "setup.cfg", "ruff.toml", ".ruff.toml", "mypy.ini",
  "go.mod", ".golangci.yml", ".golangci.yaml",
  "Cargo.toml",
  "pom.xml", "build.gradle", "build.gradle.kts", "gradlew",
  "composer.json",
  "Makefile",
];
