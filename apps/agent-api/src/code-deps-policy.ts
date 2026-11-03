/**
 * C4a: install policy for the Coding Agent.
 *
 * The classifier (C4) decides *whether* a command may run; this module decides *how* dependency
 * installation happens when it is allowed:
 *
 * - every manager gets an explicit, reproducible command line (`--ignore-scripts`, `--frozen-lockfile`,
 *   `--only-binary=:all:`, `--no-scripts --no-plugins`, `--locked`, `-mod=readonly` …),
 * - a lockfile is mandatory unless the deployment explicitly opts out,
 * - installation is split into a `fetch` phase (network, allowlisted registries only) and a `build`
 *   phase (network hard-disabled), because building untrusted code with network access is the exact
 *   supply-chain hole this step closes,
 * - lifecycle scripts never run implicitly: they run only for packages on the allowlist and only as a
 *   separate, approval-gated command,
 * - the environment handed to installers is scrubbed of every secret-shaped variable and hardened
 *   (no git hooks, no credential prompts, no corepack prompt, no LFS smudge),
 * - git itself gets hardening arguments so hooks, submodules and filters cannot execute anything.
 *
 * Nothing here executes a process: `runInstallPlan` takes an injected runner port, so the module is
 * pure enough to test and cannot smuggle execution onto the host.
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "pip" | "uv" | "poetry" | "composer" | "cargo" | "go" | "unknown";

export const PACKAGE_MANAGERS: readonly PackageManager[] = ["npm", "pnpm", "yarn", "pip", "uv", "poetry", "composer", "cargo", "go"] as const;

export type InstallPhase = "fetch" | "build";

/** Lockfile expected for each manager, used both for detection and for the refusal message. */
export const LOCKFILES: Record<Exclude<PackageManager, "unknown" | "pip">, string> = {
  npm: "package-lock.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
  uv: "uv.lock",
  poetry: "poetry.lock",
  composer: "composer.lock",
  cargo: "Cargo.lock",
  go: "go.sum",
};

/** Managers whose install cannot be reproduced without a lockfile. */
const LOCKFILE_REQUIRED: readonly PackageManager[] = ["npm", "pnpm", "yarn", "uv", "poetry", "composer", "cargo", "go"];

export interface DepsPolicyLimits {
  /** Packages whose lifecycle scripts may run, and only through a separate approved command. */
  allowedScriptPackages: string[];
  /** Registry/index hosts the fetch phase may reach. */
  registries: string[];
  /** Whether a source distribution (no wheel) may be installed at all; it always needs approval. */
  allowSdist: boolean;
  /** Upper bound on generated commands, so a plan cannot explode. */
  maxPlanCommands: number;
  /** Whether a missing lockfile is a hard problem (default true). */
  requireLockfile: boolean;
  /** Directory used for the empty git config / hooks path. */
  gitIsolationDir: string;
}

export const DEFAULT_DEPS_POLICY_LIMITS: DepsPolicyLimits = {
  allowedScriptPackages: [],
  registries: [
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "pypi.org",
    "files.pythonhosted.org",
    "proxy.golang.org",
    "crates.io",
    "static.crates.io",
    "repo.packagist.org",
    "github.com",
    "objects.githubusercontent.com",
  ],
  allowSdist: false,
  maxPlanCommands: 8,
  requireLockfile: true,
  gitIsolationDir: "/tmp/npati-git-isolation",
};

function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return !/^(?:0|false|no|off)$/i.test(value);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Configuration is env-overridable; the module contains no deployment-specific literals in logic. */
export function resolveDepsPolicyLimits(env: NodeJS.ProcessEnv = process.env, overrides: Partial<DepsPolicyLimits> = {}): DepsPolicyLimits {
  return {
    allowedScriptPackages: overrides.allowedScriptPackages
      ?? list(env.NPATI_CODE_DEPS_ALLOWED_SCRIPT_PACKAGES)
      ?? DEFAULT_DEPS_POLICY_LIMITS.allowedScriptPackages,
    registries: overrides.registries ?? list(env.NPATI_CODE_DEPS_REGISTRIES) ?? DEFAULT_DEPS_POLICY_LIMITS.registries,
    allowSdist: overrides.allowSdist ?? bool(env.NPATI_CODE_DEPS_ALLOW_SDIST, DEFAULT_DEPS_POLICY_LIMITS.allowSdist),
    maxPlanCommands: overrides.maxPlanCommands
      ?? positiveInt(env.NPATI_CODE_DEPS_MAX_COMMANDS, DEFAULT_DEPS_POLICY_LIMITS.maxPlanCommands),
    requireLockfile: overrides.requireLockfile ?? bool(env.NPATI_CODE_DEPS_REQUIRE_LOCKFILE, DEFAULT_DEPS_POLICY_LIMITS.requireLockfile),
    gitIsolationDir: overrides.gitIsolationDir
      ?? (env.NPATI_CODE_DEPS_GIT_ISOLATION_DIR || DEFAULT_DEPS_POLICY_LIMITS.gitIsolationDir),
  };
}

/** Detects the package manager behind a command line (or behind the project's lockfiles). */
export function detectPackageManager(command: string, files?: string[]): PackageManager {
  const head = String(command ?? "").trim().split(/\s+/)[0] ?? "";
  const executable = head.split("/").pop() ?? head;
  if (executable === "npm" || executable === "npx") return "npm";
  if (executable === "pnpm") return "pnpm";
  // `corepack pnpm …` / `corepack yarn …` delegate to the real manager named in the next token.
  if (executable === "corepack") {
    const next = String(command ?? "").trim().split(/\s+/)[1] ?? "";
    if (next === "yarn") return "yarn";
    if (next === "npm") return "npm";
    return "pnpm";
  }
  if (executable === "yarn") return "yarn";
  if (executable === "pip" || executable === "pip3" || executable === "python" || executable === "python3") return "pip";
  if (executable === "uv") return "uv";
  if (executable === "poetry") return "poetry";
  if (executable === "composer") return "composer";
  if (executable === "cargo") return "cargo";
  if (executable === "go") return "go";
  if (files?.length) {
    if (files.includes("pnpm-lock.yaml")) return "pnpm";
    if (files.includes("yarn.lock")) return "yarn";
    if (files.includes("uv.lock")) return "uv";
    if (files.includes("poetry.lock")) return "poetry";
    if (files.includes("composer.lock")) return "composer";
    if (files.includes("Cargo.lock")) return "cargo";
    if (files.includes("go.sum")) return "go";
    if (files.includes("package-lock.json")) return "npm";
  }
  return "unknown";
}

export interface InstallPlanInput {
  manager: PackageManager;
  /** Arguments the model asked for, used only to carry over explicit flags such as `--only main`. */
  args?: string[];
  /** Whether the matching lockfile exists in the workspace. */
  lockfilePresent?: boolean;
  /** Files present in the workspace, used for yarn berry detection and lockfile inference. */
  files?: string[];
  /** True when the resolution produced a source distribution instead of a wheel. */
  sdist?: boolean;
  /** Registry host discovered from configuration; must be allowlisted. */
  registryHost?: string;
  /** Explicit package list for the separate lifecycle-script command. */
  scriptPackages?: string[];
  limits?: Partial<DepsPolicyLimits>;
}

export interface InstallPlan {
  manager: PackageManager;
  phaseCommands: { fetch: string[]; build: string[] };
  networkPhases: { fetch: boolean; build: boolean };
  requiresLockfile: boolean;
  /** Blocking problems: when non-empty the plan must not run at all. */
  problems: string[];
  /** True when the plan may only run after an approval. */
  requiresApproval: boolean;
  approvalReasons: string[];
  /** Environment additions for the plan (already scrubbed separately). */
  env: Record<string, string>;
}

const ENV_GO_READONLY: Record<string, string> = { GOFLAGS: "-mod=readonly", GONOSUMDB: "", GONOSUMCHECK: "1", GOTOOLCHAIN: "local" };

/** The command that adds one named package. Scripts stay off, as in the plain install. */
export function packageAddCommand(manager: string, spec: string, dev: boolean): string | null {
  if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:@[A-Za-z0-9.~*_-]+)?$/.test(spec)) return null;
  switch (manager) {
    case "npm": return `npm install ${spec}${dev ? " --save-dev" : ""} --ignore-scripts --no-fund`;
    case "pnpm": return `pnpm add ${spec}${dev ? " -D" : ""} --ignore-scripts`;
    case "yarn": return `yarn add ${spec}${dev ? " -D" : ""} --ignore-scripts`;
    default: return null;
  }
}

/** Builds the reproducible, phased install plan. Pure: it never runs anything. */
export function buildInstallPlan(input: InstallPlanInput): InstallPlan {
  const limits = { ...DEFAULT_DEPS_POLICY_LIMITS, ...(input.limits ?? {}) };
  const problems: string[] = [];
  const approvalReasons: string[] = [];
  const plan: InstallPlan = {
    manager: input.manager,
    phaseCommands: { fetch: [], build: [] },
    networkPhases: { fetch: true, build: false },
    requiresLockfile: LOCKFILE_REQUIRED.includes(input.manager),
    problems,
    requiresApproval: false,
    approvalReasons,
    env: {},
  };

  if (input.manager === "unknown") {
    problems.push("unknown_package_manager");
    return plan;
  }

  const lockfile = input.manager === "pip" ? undefined : LOCKFILES[input.manager as Exclude<PackageManager, "unknown" | "pip">];
  const lockfilePresent = input.lockfilePresent ?? (lockfile !== undefined && (input.files?.includes(lockfile) ?? false));
  if (plan.requiresLockfile && limits.requireLockfile && !lockfilePresent) {
    problems.push("lockfile_required");
  }

  if (input.registryHost && !assertRegistryAllowed(input.registryHost, limits.registries)) {
    problems.push("registry_not_allowed");
  }

  const yarnBerry = input.files?.includes(".yarnrc.yml") ?? false;

  switch (input.manager) {
    case "npm":
      plan.phaseCommands.fetch = ["npm ci --ignore-scripts --no-fund"];
      break;
    case "pnpm":
      plan.phaseCommands.fetch = ["pnpm install --frozen-lockfile --ignore-scripts"];
      break;
    case "yarn":
      plan.phaseCommands.fetch = [yarnBerry
        ? "yarn install --immutable --ignore-scripts"
        : "yarn install --frozen-lockfile --ignore-scripts"];
      break;
    case "pip":
      if (input.sdist) {
        // A source distribution runs arbitrary build code, so it can never be part of the automatic
        // path: it needs an approval and is refused outright when the deployment forbids sdist.
        approvalReasons.push("sdist_requires_approval");
        if (!limits.allowSdist) problems.push("sdist_not_allowed");
        plan.phaseCommands.fetch = ["pip install --no-binary=:all: --no-deps -r requirements.txt"];
      } else {
        plan.phaseCommands.fetch = ["pip install --only-binary=:all: -r requirements.txt"];
      }
      break;
    case "uv":
      plan.phaseCommands.fetch = ["uv sync --frozen --no-install-project"];
      break;
    case "poetry":
      plan.phaseCommands.fetch = ["poetry install --no-root --no-ansi"];
      break;
    case "composer":
      plan.phaseCommands.fetch = ["composer install --no-scripts --no-plugins --no-interaction --prefer-dist"];
      break;
    case "cargo":
      plan.phaseCommands.fetch = ["cargo fetch --locked"];
      plan.phaseCommands.build = ["cargo build --locked --offline"];
      break;
    case "go":
      plan.phaseCommands.fetch = ["go mod download"];
      plan.phaseCommands.build = ["go build -mod=readonly ./..."];
      plan.env = { ...ENV_GO_READONLY };
      if (input.registryHost === undefined) plan.env.GOPROXY = limits.registries.includes("proxy.golang.org") ? "https://proxy.golang.org" : "off";
      break;
    default:
      break;
  }

  const commandCount = plan.phaseCommands.fetch.length + plan.phaseCommands.build.length;
  if (commandCount > limits.maxPlanCommands) problems.push("plan_too_large");

  if (input.scriptPackages?.length) {
    const script = buildScriptCommand(input.manager, input.scriptPackages, limits);
    if (!script.command) problems.push(script.reason ?? "scripts_not_allowed");
    else {
      approvalReasons.push("lifecycle_scripts_require_approval");
      plan.phaseCommands.build.push(script.command);
    }
  }

  plan.requiresApproval = approvalReasons.length > 0 || problems.includes("sdist_requires_approval");
  return plan;
}

export interface ScriptCommandResult {
  command: string | null;
  allowed: string[];
  denied: string[];
  reason?: string;
}

/**
 * Lifecycle scripts never run as part of install. They run as one separate command, and only for
 * packages that the operator explicitly allowlisted; anything else is refused.
 */
export function buildScriptCommand(manager: PackageManager, packages: string[], limits: DepsPolicyLimits): ScriptCommandResult {
  const requested = packages.map((name) => name.trim()).filter(Boolean);
  const allowed = requested.filter((name) => limits.allowedScriptPackages.includes(name));
  const denied = requested.filter((name) => !limits.allowedScriptPackages.includes(name));
  if (!requested.length) return { command: null, allowed, denied, reason: "no_script_packages_requested" };
  if (denied.length) return { command: null, allowed, denied, reason: "scripts_not_allowlisted" };
  switch (manager) {
    case "npm":
      return { command: `npm rebuild ${allowed.join(" ")}`, allowed, denied };
    case "pnpm":
      return { command: `pnpm rebuild ${allowed.join(" ")}`, allowed, denied };
    case "yarn":
      return { command: `yarn rebuild ${allowed.join(" ")}`, allowed, denied };
    default:
      return { command: null, allowed, denied, reason: "scripts_not_supported_for_manager" };
  }
}

/** Secret-shaped variables, plus the credential files that could leak into an install. */
const SECRET_ENV_PATTERN = /(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|APIKEY|CREDENTIAL|PRIVATE_KEY|SSH_|GIT_ASKPASS|GIT_CREDENTIAL|NPM_TOKEN|NODE_AUTH_TOKEN|PIP_INDEX_URL|PIP_EXTRA_INDEX_URL|TWINE_|AWS_|AZURE_|GOOGLE_|GCP_|KUBECONFIG|NETRC|DOCKER_AUTH|COMPOSER_AUTH|CARGO_REGISTRY_TOKEN)/i;
const SECRET_ENV_NAMES = new Set(["HOME_SECRETS", "VAULT_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "GL_TOKEN"]);

/**
 * Hardening applied to every installer environment: no credential prompts, no hooks, no audit
 * prompts, no implicit script execution. Nothing here is a secret.
 */
export const INSTALL_HARDENING_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/true",
  GIT_LFS_SKIP_SMUDGE: "1",
  HUSKY: "0",
  CI: "1",
  npm_config_ignore_scripts: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  YARN_ENABLE_TELEMETRY: "0",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  PIP_NO_INPUT: "1",
  POETRY_NO_INTERACTION: "1",
  COMPOSER_NO_INTERACTION: "1",
  CARGO_NET_OFFLINE: "false",
};

/**
 * Returns an environment that contains no secret-shaped variable. `base` is the environment the
 * sandbox would otherwise use; every key that could carry a credential is dropped rather than
 * blanked, so an installer cannot even see that it exists.
 */
export function scrubbedEnvironment(base: Record<string, string | undefined> = {}, options: { secretNames?: string[]; extra?: Record<string, string> } = {}): Record<string, string> {
  const explicit = new Set([...(options.secretNames ?? []).map((name) => name.trim()).filter(Boolean), ...SECRET_ENV_NAMES]);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SECRET_ENV_PATTERN.test(name) || explicit.has(name)) continue;
    if (/^(?:GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_DIR|GIT_WORK_TREE)$/i.test(name)) continue;
    result[name] = value;
  }
  return { ...result, ...INSTALL_HARDENING_ENV, ...(options.extra ?? {}) };
}

/** Paths that must exist (empty) for git isolation; the sandbox layer creates them. */
export function gitIsolationPaths(limits: DepsPolicyLimits): { emptyConfigFile: string; emptyHooksDir: string } {
  const dir = limits.gitIsolationDir.replace(/\/+$/, "");
  return { emptyConfigFile: `${dir}/gitconfig-empty`, emptyHooksDir: `${dir}/hooks-empty` };
}

/**
 * Environment that disables every git hook, filter and credential helper for commands that do not go
 * through `gitConfigHardeningArgs` (for example the `git` calls an installer runs itself).
 */
export function gitHooksDisabledEnv(limits: DepsPolicyLimits = DEFAULT_DEPS_POLICY_LIMITS, base: Record<string, string | undefined> = {}): Record<string, string> {
  const paths = gitIsolationPaths(limits);
  return {
    ...scrubbedEnvironment(base),
    GIT_CONFIG_GLOBAL: paths.emptyConfigFile,
    GIT_CONFIG_SYSTEM: paths.emptyConfigFile,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
    GIT_LFS_SKIP_SMUDGE: "1",
    NPATI_GIT_HOOKS_PATH: paths.emptyHooksDir,
  };
}

/**
 * Arguments that neutralise hooks, submodules and filters for a git command run inside the sandbox.
 * `submodule.recurse=false` and the empty LFS filter mean a checkout cannot execute anything.
 */
export function gitConfigHardeningArgs(hooksDir = `${DEFAULT_DEPS_POLICY_LIMITS.gitIsolationDir}/hooks-empty`): string[] {
  return [
    "-c", `core.hooksPath=${hooksDir}`,
    "-c", "protocol.file.allow=never",
    "-c", "submodule.recurse=false",
    "-c", "filter.lfs.smudge=",
    "-c", "filter.lfs.process=",
    "-c", "filter.lfs.required=false",
    "-c", "credential.helper=",
    "-c", "core.askPass=",
  ];
}

/**
 * C11 (owner decision 6): the git hardening for the **agent shell** (`code.shell.exec` and the Project
 * terminal), built from the same primitives and the same values the installer path already uses.
 *
 * Why the shell path needs it: `/workspace/.git/config` (and a container-global config) persists for the
 * lifetime of the sandbox, so a `git push` started from an agent command could pick up a credential
 * helper, an authorization `extraheader` or an askpass that some earlier step left there. The environment
 * below is delivered with **command-line scope** (`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`), which wins over
 * the repository config, and it *resets* the credential surfaces rather than merely adding to them:
 *
 *   - `credential.helper=` with an empty value resets the helper list, so no stored helper can run;
 *   - `core.askPass=` and `GIT_ASKPASS=/bin/true` mean an interactive prompt cannot become a credential;
 *   - `http.https://github.com/.extraheader=` with an empty value neutralises an `extraheader` that was
 *     persisted in the repository config;
 *   - `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` remove the system and user configs
 *     (`/dev/null` exists in the container, so no bootstrap file has to be provisioned for this to hold);
 *   - `GIT_TERMINAL_PROMPT=0` and `GIT_LFS_SKIP_SMUDGE=1` are the same values `gitHooksDisabledEnv` uses.
 *
 * `scrubbedEnvironment`/`INSTALL_HARDENING_ENV` are deliberately **not** reused here: they carry the
 * installer's package-manager knobs (`npm_config_ignore_scripts`, `PIP_NO_INPUT`, ...), and this
 * environment is applied to *every* sandboxed command, including the `pnpm install` the terminal path
 * runs for a project without `node_modules`. The git-specific half of that function is what is borrowed.
 */
export function gitShellHardeningEnv(limits: DepsPolicyLimits = DEFAULT_DEPS_POLICY_LIMITS): Record<string, string> {
  const paths = gitIsolationPaths(limits);
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
    GIT_LFS_SKIP_SMUDGE: "1",
    NPATI_GIT_HOOKS_PATH: paths.emptyHooksDir,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "core.askPass",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_2: "",
  };
}

/** Exact-or-subdomain registry check: `registry.npmjs.org.evil.com` is not allowlisted. */
export function assertRegistryAllowed(host: string, allowlist: string[] = DEFAULT_DEPS_POLICY_LIMITS.registries): boolean {
  const target = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!target) return false;
  return allowlist.some((entry) => {
    const allowed = entry.trim().toLowerCase().replace(/\.$/, "");
    if (!allowed) return false;
    return target === allowed || target.endsWith(`.${allowed}`);
  });
}

export interface RegistryReading {
  registryHosts: string[];
  indexUrls: string[];
  /** Sources that mention a registry but could not be parsed; the caller should treat them as unknown. */
  unparsed: string[];
}

/**
 * Reads registry configuration from project files **as text**: nothing is executed, no package manager
 * is invoked, and an unparsable file is reported instead of being trusted.
 */
export function registryFromConfig(files: Record<string, string> = {}): RegistryReading {
  const registryHosts = new Set<string>();
  const indexUrls = new Set<string>();
  const unparsed: string[] = [];

  const addUrl = (value: string | undefined) => {
    if (!value) return;
    const cleaned = value.trim().replace(/^["']|["']$/g, "");
    indexUrls.add(cleaned);
    try {
      registryHosts.add(new URL(cleaned).hostname.toLowerCase());
    } catch {
      unparsed.push(cleaned);
    }
  };

  const npmrc = files[".npmrc"];
  if (npmrc) for (const line of npmrc.split(/\r?\n/)) {
    const match = /^\s*(?:@[^:]+:)?registry\s*=\s*(\S+)/i.exec(line);
    if (match) addUrl(match[1]);
  }

  for (const name of [".yarnrc", ".yarnrc.yml"]) {
    const content = files[name];
    if (!content) continue;
    for (const line of content.split(/\r?\n/)) {
      const match = /^\s*(?:npmRegistryServer|registry)\s*[:=]?\s*["']?(\S+?)["']?\s*$/i.exec(line);
      if (match) addUrl(match[1]);
    }
  }

  const pipConf = files["pip.conf"] ?? files[".pip/pip.conf"];
  if (pipConf) for (const line of pipConf.split(/\r?\n/)) {
    const match = /^\s*(?:index-url|extra-index-url)\s*=\s*(\S+)/i.exec(line);
    if (match) addUrl(match[1]);
  }

  const pyproject = files["pyproject.toml"];
  if (pyproject) for (const line of pyproject.split(/\r?\n/)) {
    const match = /^\s*(?:url|index-url)\s*=\s*["'](\S+?)["']/i.exec(line);
    if (match) addUrl(match[1]);
  }

  const composer = files["composer.json"];
  if (composer) {
    try {
      const parsed = JSON.parse(composer) as { repositories?: Array<{ url?: string } | string> };
      for (const repository of parsed.repositories ?? []) {
        if (typeof repository === "string") addUrl(repository);
        else addUrl(repository?.url);
      }
    } catch {
      unparsed.push("composer.json");
    }
  }

  return { registryHosts: [...registryHosts].sort(), indexUrls: [...indexUrls].sort(), unparsed };
}

export interface InstallRunnerOptions {
  phase: InstallPhase;
  /** `false` means the runner must run the command with the network disabled. */
  network: boolean;
  env: Record<string, string>;
}

export interface InstallRunner {
  /**
   * `true` means the runner can actually run a build phase with the network disabled. When it is not
   * `true`, a plan with a build phase is refused instead of being run with network access.
   */
  supportsNetworkIsolation?: boolean;
  run(command: string, options: InstallRunnerOptions): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
}

export interface InstallRunResult {
  ok: boolean;
  code?: "lockfile_required" | "registry_not_allowed" | "plan_too_large" | "sdist_not_allowed" | "unknown_package_manager" | "network_isolation_unavailable" | "install_failed" | "approval_required";
  message?: string;
  phases: Array<{ phase: InstallPhase; command: string; network: boolean; exitCode: number; stdout?: string; stderr?: string }>;
}

/**
 * Runs a plan through an injected runner. Fail-closed behaviour:
 * - a plan with blocking problems is not run at all,
 * - the build phase never runs without proven network isolation,
 * - the first non-zero exit stops the plan.
 */
export async function runInstallPlan(
  plan: InstallPlan,
  runner: InstallRunner,
  options: { env?: Record<string, string | undefined>; requireApproval?: boolean; approved?: boolean; limits?: DepsPolicyLimits } = {},
): Promise<InstallRunResult> {
  const phases: InstallRunResult["phases"] = [];
  if (plan.problems.length) {
    const code = plan.problems[0] as InstallRunResult["code"];
    return { ok: false, code, message: `install plan refused: ${plan.problems.join(", ")}`, phases };
  }
  if (plan.requiresApproval && options.requireApproval !== false && options.approved !== true) {
    return { ok: false, code: "approval_required", message: `install plan requires approval: ${plan.approvalReasons.join(", ")}`, phases };
  }
  if (plan.phaseCommands.build.length && runner.supportsNetworkIsolation !== true) {
    // Running a build with network access is exactly the hole this step exists to close.
    return { ok: false, code: "network_isolation_unavailable", message: "the sandbox cannot run the build phase without network access", phases };
  }

  const base = options.env ?? {};
  const limits = options.limits ?? DEFAULT_DEPS_POLICY_LIMITS;
  const env = { ...gitHooksDisabledEnv(limits, base), ...plan.env };

  for (const phase of ["fetch", "build"] as const) {
    const network = plan.networkPhases[phase];
    for (const command of plan.phaseCommands[phase]) {
      const result = await runner.run(command, { phase, network, env });
      phases.push({ phase, command, network, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
      if (result.exitCode !== 0) {
        return { ok: false, code: "install_failed", message: `${phase} phase failed: ${command}`, phases };
      }
    }
  }
  return { ok: true, phases };
}
