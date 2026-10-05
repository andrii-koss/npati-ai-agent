import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEPS_POLICY_LIMITS,
  INSTALL_HARDENING_ENV,
  LOCKFILES,
  assertRegistryAllowed,
  buildInstallPlan,
  buildScriptCommand,
  detectPackageManager,
  gitConfigHardeningArgs,
  gitHooksDisabledEnv,
  gitIsolationPaths,
  registryFromConfig,
  resolveDepsPolicyLimits,
  runInstallPlan,
  scrubbedEnvironment,
  type DepsPolicyLimits,
  type InstallRunner,
  type InstallRunnerOptions,
} from "../apps/agent-api/src/code-deps-policy";

/**
 * C4a: the install policy is the supply-chain gate for dependencies. These tests run **no** installer:
 * they assert the generated command lines, the two-phase network split, the scrubbed environment and
 * the git hardening, which is what actually decides whether a package can run code in the sandbox.
 */

const limits: DepsPolicyLimits = {
  ...DEFAULT_DEPS_POLICY_LIMITS,
  allowedScriptPackages: ["esbuild", "sharp"],
  registries: [...DEFAULT_DEPS_POLICY_LIMITS.registries],
};

function runner(options: { networkIsolation?: boolean; failOn?: string } = {}) {
  const calls: Array<{ command: string; options: InstallRunnerOptions }> = [];
  const port: InstallRunner & { calls: typeof calls } = {
    calls,
    supportsNetworkIsolation: options.networkIsolation ?? true,
    async run(command: string, runOptions: InstallRunnerOptions) {
      calls.push({ command, options: runOptions });
      const exitCode = options.failOn && command.includes(options.failOn) ? 1 : 0;
      return { exitCode, stdout: "ok", stderr: "" };
    },
  };
  return port;
}

describe("security-gate: C4a install policy", () => {
  it("requires a lockfile for every manager that cannot install reproducibly without one", () => {
    for (const manager of ["npm", "pnpm", "yarn", "uv", "poetry", "composer", "cargo", "go"] as const) {
      const withoutLockfile = buildInstallPlan({ manager, files: [], limits });
      expect(withoutLockfile.requiresLockfile, manager).toBe(true);
      expect(withoutLockfile.problems, manager).toContain("lockfile_required");
      const withLockfile = buildInstallPlan({ manager, files: [LOCKFILES[manager as keyof typeof LOCKFILES]], limits });
      expect(withLockfile.problems, manager).not.toContain("lockfile_required");
    }
    // pip installs from requirements.txt; the lockfile rule does not apply to it.
    expect(buildInstallPlan({ manager: "pip", files: [], limits }).requiresLockfile).toBe(false);
  });

  it("generates the exact reproducible flags for every manager", () => {
    const cases: Array<[Parameters<typeof buildInstallPlan>[0]["manager"], string[], string[]]> = [
      ["npm", ["npm ci --ignore-scripts --no-fund"], []],
      ["pnpm", ["pnpm install --frozen-lockfile --ignore-scripts"], []],
      ["yarn", ["yarn install --frozen-lockfile --ignore-scripts"], []],
      ["pip", ["pip install --only-binary=:all: -r requirements.txt"], []],
      ["uv", ["uv sync --frozen --no-install-project"], []],
      ["poetry", ["poetry install --no-root --no-ansi"], []],
      ["composer", ["composer install --no-scripts --no-plugins --no-interaction --prefer-dist"], []],
      ["cargo", ["cargo fetch --locked"], ["cargo build --locked --offline"]],
      ["go", ["go mod download"], ["go build -mod=readonly ./..."]],
    ];
    for (const [manager, fetch, build] of cases) {
      const plan = buildInstallPlan({ manager, lockfilePresent: true, limits });
      expect(plan.phaseCommands.fetch, manager).toEqual(fetch);
      expect(plan.phaseCommands.build, manager).toEqual(build);
      // Never a lifecycle-script escape hatch in the automatic path.
      expect(plan.phaseCommands.fetch.join(" "), manager).not.toMatch(/--foreground-scripts|--scripts-prepend-node-path/);
    }
  });

  it("pins yarn berry to --immutable and keeps the fetch phase as the only networked phase", () => {
    const berry = buildInstallPlan({ manager: "yarn", files: [".yarnrc.yml", "yarn.lock"], limits });
    expect(berry.phaseCommands.fetch).toEqual(["yarn install --immutable --ignore-scripts"]);
    const classic = buildInstallPlan({ manager: "yarn", files: ["yarn.lock"], limits });
    expect(classic.phaseCommands.fetch).toEqual(["yarn install --frozen-lockfile --ignore-scripts"]);
    for (const plan of [berry, classic, buildInstallPlan({ manager: "cargo", lockfilePresent: true, limits })]) {
      expect(plan.networkPhases.fetch).toBe(true);
      expect(plan.networkPhases.build).toBe(false);
    }
  });

  it("forces a source distribution through approval and refuses it when the deployment forbids it", () => {
    const allowed = buildInstallPlan({ manager: "pip", sdist: true, limits: { ...limits, allowSdist: true } });
    expect(allowed.requiresApproval).toBe(true);
    expect(allowed.approvalReasons).toContain("sdist_requires_approval");
    expect(allowed.problems).not.toContain("sdist_not_allowed");
    const forbidden = buildInstallPlan({ manager: "pip", sdist: true, limits });
    expect(forbidden.problems).toContain("sdist_not_allowed");
  });

  it("runs lifecycle scripts only for allowlisted packages and only as a separate approved command", () => {
    const allowlisted = buildInstallPlan({ manager: "npm", lockfilePresent: true, scriptPackages: ["esbuild"], limits });
    expect(allowlisted.phaseCommands.build).toContain("npm rebuild esbuild");
    expect(allowlisted.requiresApproval).toBe(true);
    expect(allowlisted.approvalReasons).toContain("lifecycle_scripts_require_approval");

    const denied = buildInstallPlan({ manager: "npm", lockfilePresent: true, scriptPackages: ["evil-postinstall"], limits });
    expect(denied.problems).toContain("scripts_not_allowlisted");
    expect(denied.phaseCommands.build).toEqual([]);

    expect(buildScriptCommand("npm", ["esbuild"], limits).command).toBe("npm rebuild esbuild");
    expect(buildScriptCommand("pnpm", ["esbuild", "sharp"], limits).command).toBe("pnpm rebuild esbuild sharp");
    expect(buildScriptCommand("cargo", ["esbuild"], limits).reason).toBe("scripts_not_supported_for_manager");
    expect(buildScriptCommand("npm", ["esbuild", "sharp", "left-pad"], limits).reason).toBe("scripts_not_allowlisted");
  });

  it("refuses an install plan whose registry is not allowlisted", () => {
    const plan = buildInstallPlan({ manager: "npm", lockfilePresent: true, registryHost: "registry.evil.example", limits });
    expect(plan.problems).toContain("registry_not_allowed");
    const good = buildInstallPlan({ manager: "npm", lockfilePresent: true, registryHost: "registry.npmjs.org", limits });
    expect(good.problems).toEqual([]);
    expect(assertRegistryAllowed("registry.npmjs.org", limits.registries)).toBe(true);
    expect(assertRegistryAllowed("registry.npmjs.org.evil.com", limits.registries)).toBe(false);
    expect(assertRegistryAllowed("evil.com", limits.registries)).toBe(false);
  });

  it("never hands a secret to an installer, and always hands it the hardening flags", () => {
    const base: Record<string, string> = {
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      GITHUB_TOKEN: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      NPM_TOKEN: "npm_secret",
      NODE_AUTH_TOKEN: "npm_secret",
      AWS_SECRET_ACCESS_KEY: "aws_secret",
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      SSH_PRIVATE_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----",
      PIP_INDEX_URL: "https://user:password@private.example/simple",
      PIP_EXTRA_INDEX_URL: "https://user:password@private.example/simple",
      DOCKER_AUTH_CONFIG: '{"auths":{}}',
      VAULT_TOKEN: "hvs.secret",
      GIT_ASKPASS: "/usr/bin/askpass",
      KUBECONFIG: "/root/.kube/config",
      COMPOSER_AUTH: '{"http-basic":{}}',
      CARGO_REGISTRY_TOKEN: "cargo_secret",
      GIT_CONFIG_GLOBAL: "/root/.gitconfig",
    };
    const env = scrubbedEnvironment(base, { secretNames: ["CUSTOM_CREDENTIAL"] });
    // The hardening variables are intentional (`GIT_ASKPASS=/bin/true` disables prompts); what must
    // never survive is any secret-shaped variable from the base environment or its value.
    const hardeningKeys = new Set(Object.keys(INSTALL_HARDENING_ENV));
    const leaked = Object.keys(env).filter((name) => !hardeningKeys.has(name)
      && /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY|SSH_|ASKPASS|KUBECONFIG|COMPOSER_AUTH|PIP_INDEX_URL/i.test(name));
    expect(leaked).toEqual([]);
    const joined = Object.values(env).join("\n");
    for (const secret of ["ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "npm_secret", "aws_secret", "hvs.secret", "cargo_secret", "-----BEGIN OPENSSH PRIVATE KEY-----", "password@private.example"]) {
      expect(joined).not.toContain(secret);
    }
    expect(env.PATH).toBe("/usr/bin");
    expect(env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/true",
      HUSKY: "0",
      npm_config_ignore_scripts: "true",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
    });
  });

  it("hardens git so hooks, submodules, filters and credential helpers cannot execute", () => {
    const args = gitConfigHardeningArgs();
    const text = args.join(" ");
    expect(text).toContain("core.hooksPath=");
    expect(text).toContain("protocol.file.allow=never");
    expect(text).toContain("submodule.recurse=false");
    expect(text).toContain("filter.lfs.smudge=");
    expect(text).toContain("filter.lfs.process=");
    expect(text).toContain("filter.lfs.required=false");
    expect(text).toContain("credential.helper=");
    const env = gitHooksDisabledEnv(limits, { PATH: "/usr/bin", GITHUB_TOKEN: "ghp_x" });
    const paths = gitIsolationPaths(limits);
    expect(env.GIT_CONFIG_GLOBAL).toBe(paths.emptyConfigFile);
    expect(env.GIT_CONFIG_SYSTEM).toBe(paths.emptyConfigFile);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("reads registry configuration from project files without executing anything", () => {
    const reading = registryFromConfig({
      ".npmrc": "registry=https://registry.npmjs.org/\n@scope:registry=https://npm.pkg.github.com/",
      ".yarnrc.yml": 'npmRegistryServer: "https://registry.yarnpkg.com"',
      "pip.conf": "index-url = https://pypi.org/simple\nextra-index-url = https://user:pass@private.example/simple",
      "pyproject.toml": '[[tool.poetry.source]]\nname = "internal"\nurl = "https://poetry.example/simple"',
      "composer.json": JSON.stringify({ repositories: [{ url: "https://repo.packagist.org" }, "https://composer.example"] }),
    });
    expect(reading.registryHosts).toContain("registry.npmjs.org");
    expect(reading.registryHosts).toContain("npm.pkg.github.com");
    expect(reading.registryHosts).toContain("registry.yarnpkg.com");
    expect(reading.registryHosts).toContain("pypi.org");
    expect(reading.registryHosts).toContain("private.example");
    expect(reading.registryHosts).toContain("poetry.example");
    expect(reading.registryHosts).toContain("repo.packagist.org");
    expect(reading.registryHosts).toContain("composer.example");
    expect(reading.unparsed).toEqual([]);
    const broken = registryFromConfig({ "composer.json": "{ not json" });
    expect(broken.unparsed).toContain("composer.json");
    expect(registryFromConfig({})).toEqual({ registryHosts: [], indexUrls: [], unparsed: [] });
  });

  it("detects the manager from the command line, corepack delegation and lockfiles", () => {
    expect(detectPackageManager("npm ci")).toBe("npm");
    expect(detectPackageManager("corepack pnpm install")).toBe("pnpm");
    expect(detectPackageManager("corepack yarn install")).toBe("yarn");
    expect(detectPackageManager("pip3 install -r requirements.txt")).toBe("pip");
    expect(detectPackageManager("cargo fetch --locked")).toBe("cargo");
    expect(detectPackageManager("mystery --x")).toBe("unknown");
    expect(detectPackageManager("install", ["pnpm-lock.yaml"])).toBe("pnpm");
    expect(detectPackageManager("install", ["Cargo.lock"])).toBe("cargo");
  });

  it("is configurable through the environment, with lockfiles required by default", () => {
    const resolved = resolveDepsPolicyLimits({
      NPATI_CODE_DEPS_ALLOWED_SCRIPT_PACKAGES: "esbuild, sharp",
      NPATI_CODE_DEPS_REGISTRIES: "registry.npmjs.org,internal.example",
      NPATI_CODE_DEPS_ALLOW_SDIST: "true",
      NPATI_CODE_DEPS_REQUIRE_LOCKFILE: "false",
      NPATI_CODE_DEPS_MAX_COMMANDS: "3",
      NPATI_CODE_DEPS_GIT_ISOLATION_DIR: "/tmp/custom",
    } as NodeJS.ProcessEnv);
    expect(resolved.allowedScriptPackages).toEqual(["esbuild", "sharp"]);
    expect(resolved.registries).toEqual(["registry.npmjs.org", "internal.example"]);
    expect(resolved.allowSdist).toBe(true);
    expect(resolved.requireLockfile).toBe(false);
    expect(resolved.maxPlanCommands).toBe(3);
    expect(resolved.gitIsolationDir).toBe("/tmp/custom");
    expect(DEFAULT_DEPS_POLICY_LIMITS.requireLockfile).toBe(true);
    expect(DEFAULT_DEPS_POLICY_LIMITS.allowedScriptPackages).toEqual([]);
  });
});

describe("security-gate: C4a phased install run", () => {
  it("never runs a plan with blocking problems and never runs an unapproved plan", async () => {
    const port = runner();
    const refused = await runInstallPlan(buildInstallPlan({ manager: "npm", files: [], limits }), port, { limits });
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("lockfile_required");
    expect(port.calls).toHaveLength(0);

    const sdist = buildInstallPlan({ manager: "pip", sdist: true, limits: { ...limits, allowSdist: true } });
    const unapproved = await runInstallPlan(sdist, port, { limits });
    expect(unapproved.code).toBe("approval_required");
    expect(port.calls).toHaveLength(0);
    const approved = await runInstallPlan(sdist, port, { limits, approved: true });
    expect(approved.ok).toBe(true);
    expect(port.calls).toHaveLength(1);
  });

  it("runs the fetch phase with the network and the build phase without it", async () => {
    const port = runner();
    const plan = buildInstallPlan({ manager: "cargo", lockfilePresent: true, limits });
    const result = await runInstallPlan(plan, port, { limits, env: { PATH: "/usr/bin" } });
    expect(result.ok).toBe(true);
    expect(port.calls.map((call) => [call.options.phase, call.options.network])).toEqual([["fetch", true], ["build", false]]);
    expect(port.calls[0]!.command).toBe("cargo fetch --locked");
    expect(port.calls[1]!.command).toBe("cargo build --locked --offline");
    // The environment handed to the installer is the hardened one, never the raw host environment.
    expect(port.calls[0]!.options.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", HUSKY: "0" });
    expect(port.calls[0]!.options.env.GIT_CONFIG_GLOBAL).toBeTruthy();
  });

  it("refuses to build when the sandbox cannot isolate the network, instead of building online", async () => {
    const port = runner({ networkIsolation: false });
    const plan = buildInstallPlan({ manager: "cargo", lockfilePresent: true, limits });
    const result = await runInstallPlan(plan, port, { limits });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("network_isolation_unavailable");
    // Only the networked fetch phase was attempted; the build never ran with network access.
    expect(port.calls.every((call) => call.options.phase === "fetch")).toBe(true);
    expect(port.calls.some((call) => call.command.includes("cargo build"))).toBe(false);
  });

  it("stops at the first failing phase and reports it", async () => {
    const port = runner({ failOn: "cargo fetch" });
    const plan = buildInstallPlan({ manager: "cargo", lockfilePresent: true, limits });
    const result = await runInstallPlan(plan, port, { limits });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("install_failed");
    expect(result.phases).toHaveLength(1);
    expect(port.calls).toHaveLength(1);
  });

  it("runs a manager that has no build phase in a single networked step", async () => {
    const port = runner();
    const plan = buildInstallPlan({ manager: "pnpm", lockfilePresent: true, limits });
    const result = await runInstallPlan(plan, port, { limits });
    expect(result.ok).toBe(true);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]!.options).toMatchObject({ phase: "fetch", network: true });
  });
});
