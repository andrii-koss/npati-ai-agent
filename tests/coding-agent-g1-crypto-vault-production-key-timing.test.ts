import { readFileSync } from "node:fs";
import * as nodeCrypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

/**
 * G1 (production CrashLoop): **the production key check belongs to the use of the vault, not to the import of it.**
 *
 * The deployed stack built both sandbox images, then the runner exited before it served anything:
 *
 *   `NPATI_ENCRYPTION_KEY_REQUIRED: production encryption key is not configured`
 *     at `new _CryptoVault` (`dist/chunk-…js`, the module body of `packages/workspace/src/crypto-vault.ts`)
 *
 * The throw came from `export const defaultVault = new CryptoVault()` — a **module-level** construction, so it ran
 * during `import`. The runner never encrypts anything; it walks
 *
 *   `apps/agent-api/sandbox-runner-entrypoint.sh` → `dist/sandbox-runner-server.js`
 *     → `sandbox-runner-server.ts:9`   `import { InMemoryWorkspaceStore, PostgresWorkspaceStore } from "@npati/workspace"`
 *     → `packages/workspace/src/index.ts:7`  `export * from "./crypto-vault"`
 *     → `packages/workspace/src/crypto-vault.ts:157`  `new CryptoVault()`
 *
 * and the image sets `NODE_ENV=production` (`apps/agent-api/Dockerfile:14`) while
 * `docker-compose.dokploy.yml:175-195` passes the runner no `NPATI_ENCRYPTION_KEY` (the API service at
 * `:50` gets one, the runner does not). A transitive import the runner cannot avoid was therefore able to stop
 * the process, which is the defect these tests pin from both sides:
 *
 *  - **loading is always safe** — the vault module, the `@npati/workspace` barrel that re-exports it, and the
 *    runner-path module that imports barrel values (`project-mount-policy.ts`) all evaluate in a production
 *    environment with no key configured;
 *  - **using is still impossible** — and the refusal is the same code, for the same three configurations, as
 *    before. The guarantee did not move; only the moment did.
 *
 * The last two tests are the non-vacuity proof, and they are measured on **copies** evaluated in memory: the
 * files on disk are never mutated. Restoring the refusal to the constructor makes module evaluation throw (so
 * "loading is safe" is a real assertion, not a tautology), and removing the guard from key derivation makes a
 * production vault encrypt with the ambient development key (so "using is refused" is load-bearing).
 *
 * Hermeticity: every test that changes `process.env` snapshots and restores it in `finally` and resets the module
 * registry, so `NODE_ENV=production` cannot leak into another suite and no test depends on the order it runs in.
 */

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const VAULT_PATH = "packages/workspace/src/crypto-vault.ts";
const RUNNER_ENTRYPOINT_PATH = "apps/agent-api/sandbox-runner-entrypoint.sh";
const RUNNER_SERVER_PATH = "apps/agent-api/src/sandbox-runner-server.ts";
const RUNNER_MOUNT_POLICY_PATH = "apps/agent-api/src/project-mount-policy.ts";
const WORKSPACE_BARREL_PATH = "packages/workspace/src/index.ts";
const DOCKERFILE_PATH = "apps/agent-api/Dockerfile";

/** The documented development key. `NPATI_ENV=production` + this key is the `_UNSAFE_DEFAULT` refusal. */
const DEVELOPMENT_DEFAULT_KEY = "npati-local-development-encryption-key-change-before-production";
/** A configured production key: >= 32 characters and not the development one. */
const CONFIGURED_PRODUCTION_KEY = "g1-production-encryption-key-with-at-least-32-characters";

/** The line that defers the ambient refusal. It must exist exactly once for the mutation below to mean anything. */
const DEFERRED_REFUSAL_ANCHOR = "if (masterKey && this.refusal !== null) throw new Error(this.refusal);";
/** The pre-fix behaviour: the constructor validates the ambient configuration, so `import` throws. */
const EAGER_REFUSAL_MUTATION = "if (this.refusal !== null) throw new Error(this.refusal);";
/** The guard that makes every key derivation fail closed. Removing it must let a production vault encrypt. */
const DERIVATION_GUARD_ANCHOR = "    this.assertUsable();\n    return scryptSync(this.masterKey, salt, KEY_LENGTH);";
const DERIVATION_GUARD_REMOVED = "    return scryptSync(this.masterKey, salt, KEY_LENGTH);";

const ENVIRONMENT_NAMES = ["NODE_ENV", "NPATI_ENV", "NPATI_ENCRYPTION_KEY", "ENCRYPTION_KEY"] as const;

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(workspaceRoot, relativePath), "utf8");
}

function snapshotEnvironment(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const name of ENVIRONMENT_NAMES) saved[name] = process.env[name];
  return saved;
}

function restoreEnvironment(saved: Record<string, string | undefined>): void {
  for (const name of ENVIRONMENT_NAMES) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * Runs `body` in the environment the incident ran in — `NODE_ENV=production` with no key configured anywhere —
 * and restores both the environment and the module registry afterwards, in `finally`, so a failing assertion
 * cannot leave this suite's production environment behind for the next one.
 */
async function inProductionWithoutKey<T>(body: () => Promise<T>): Promise<T> {
  const saved = snapshotEnvironment();
  try {
    process.env.NODE_ENV = "production";
    delete process.env.NPATI_ENV;
    delete process.env.NPATI_ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    vi.resetModules();
    return await body();
  } finally {
    restoreEnvironment(saved);
    vi.resetModules();
  }
}

/** The surface this suite reads off a vault, taken from the compiled module or from the shipped one. */
interface VaultInstance {
  encrypt(plaintext: string): string;
  encryptJson(value: unknown): string;
  decrypt(payload: string): string;
  decryptJson(payload: string): unknown;
  rotate(payload: string, newVaultOrKey: string): string;
}

interface VaultModuleExports {
  CryptoVault: new (masterKey?: string) => VaultInstance;
  defaultVault: VaultInstance;
}

/**
 * Evaluates a copy of `crypto-vault.ts` **in memory**, the way `import` evaluates the shipped file: the same
 * top-level statements in the same order, with `process.env` read at that moment. TypeScript is a declared
 * devDependency of this repository, so this adds no dependency, and nothing is written to disk — which is what
 * lets the non-vacuity proof mutate the module without touching the file the gate is measuring.
 *
 * The `require` shim is also a guard on the module's own dependency list: anything but `node:crypto` fails the
 * evaluation loudly rather than being silently satisfied.
 */
function evaluateVaultModule(source: string): VaultModuleExports {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: VAULT_PATH,
  });
  const requireShim = (specifier: string): unknown => {
    if (specifier === "node:crypto") return nodeCrypto;
    throw new Error(`crypto-vault.ts must import nothing but node:crypto; it imported: ${specifier}`);
  };
  // The object the compiled `exports.X = …` assignments land on. Typed as the contract the assertions read; the
  // compiled module is what fills it in.
  const exportsShim = {} as VaultModuleExports;
  const evaluate = new Function("require", "exports", outputText);
  evaluate(requireShim, exportsShim);
  return exportsShim;
}

describe("security-gate: G1 — the production encryption key is checked at use, not at import", () => {
  it("loads `crypto-vault.ts` in production with no key configured", async () => {
    await inProductionWithoutKey(async () => {
      let failure: unknown = null;
      try {
        await import("../packages/workspace/src/crypto-vault");
      } catch (error) {
        failure = error;
      }
      // The whole incident in one assertion: this import used to die on `NPATI_ENCRYPTION_KEY_REQUIRED`.
      expect(failure).toBe(null);
    });
  });

  it("loads the sandbox runner's own import edges in production with no key configured", async () => {
    await inProductionWithoutKey(async () => {
      // These are the two runtime edges the runner evaluates before it can serve anything: the barrel itself
      // (`sandbox-runner-server.ts:9`) and a runner-path module that imports barrel *values*
      // (`sandbox-runner-server.ts:15` -> `project-mount-policy.ts`). Both therefore evaluate `new CryptoVault()`.
      const failures: Record<string, unknown> = {};
      try {
        await import("@npati/workspace");
      } catch (error) {
        failures["@npati/workspace"] = error;
      }
      try {
        await import("../apps/agent-api/src/project-mount-policy");
      } catch (error) {
        failures["apps/agent-api/src/project-mount-policy.ts"] = error;
      }
      expect(failures).toEqual({});
    });
  });

  it("refuses every cryptographic operation, with the same code, when production has no key", async () => {
    await inProductionWithoutKey(async () => {
      const { CryptoVault, defaultVault } = await import("../packages/workspace/src/crypto-vault");
      const vault = new CryptoVault();

      expect(() => vault.encrypt("plaintext")).toThrow("NPATI_ENCRYPTION_KEY_REQUIRED");
      expect(() => vault.encryptJson({ secret: "value" })).toThrow("NPATI_ENCRYPTION_KEY_REQUIRED");
      expect(() => vault.decrypt("v1$00$00$00$00")).toThrow("NPATI_ENCRYPTION_KEY_REQUIRED");
      expect(() => vault.rotate("v1$00$00$00$00", "rotation-target-key-with-at-least-32-characters")).toThrow("NPATI_ENCRYPTION_KEY_REQUIRED");

      // The module-level instance is the one the runner's barrel constructs, so it carries the same obligation.
      expect(() => defaultVault.encrypt("plaintext")).toThrow("NPATI_ENCRYPTION_KEY_REQUIRED");
      expect(() => defaultVault.decrypt("v1$00$00$00$00")).toThrow("NPATI_ENCRYPTION_KEY_REQUIRED");
    });
  });

  it("keeps refusing the development default key in production, at the operation for the ambient key and at the call for an explicit one", async () => {
    await inProductionWithoutKey(async () => {
      // The second production crash shape: an operator who configures the documented development key. Loading must
      // still be safe, and the refusal must still land — on the operation, not on the import.
      process.env.NPATI_ENV = "production";
      process.env.NPATI_ENCRYPTION_KEY = DEVELOPMENT_DEFAULT_KEY;

      const { CryptoVault } = await import("../packages/workspace/src/crypto-vault");
      const ambient = new CryptoVault();
      expect(() => ambient.encrypt("plaintext")).toThrow("NPATI_ENCRYPTION_KEY_UNSAFE_DEFAULT");
      expect(() => new CryptoVault(DEVELOPMENT_DEFAULT_KEY)).toThrow("NPATI_ENCRYPTION_KEY_UNSAFE_DEFAULT");
    });
  });

  it("keeps refusing a too-short key in production, at the operation for the ambient key and at the call for an explicit one", async () => {
    await inProductionWithoutKey(async () => {
      process.env.NPATI_ENCRYPTION_KEY = "short-key";

      const { CryptoVault } = await import("../packages/workspace/src/crypto-vault");
      const ambient = new CryptoVault();
      expect(() => ambient.encrypt("plaintext")).toThrow("NPATI_ENCRYPTION_KEY_TOO_SHORT");
      expect(() => new CryptoVault("too-short")).toThrow("NPATI_ENCRYPTION_KEY_TOO_SHORT");
    });
  });

  it("encrypts and decrypts with a configured production key", async () => {
    await inProductionWithoutKey(async () => {
      process.env.NPATI_ENCRYPTION_KEY = CONFIGURED_PRODUCTION_KEY;

      const { CryptoVault, defaultVault } = await import("../packages/workspace/src/crypto-vault");
      const vault = new CryptoVault();
      const sealed = vault.encrypt("sk-live-production-secret");

      expect(sealed).not.toContain("sk-live-production-secret");
      expect(vault.decrypt(sealed)).toBe("sk-live-production-secret");
      expect(vault.decryptJson(vault.encryptJson({ provider: "anthropic" }))).toEqual({ provider: "anthropic" });
      expect(defaultVault.decrypt(defaultVault.encrypt("module-level-instance"))).toBe("module-level-instance");
    });
  });

  it("pins the import chain the incident travelled, so this suite cannot quietly stop measuring it", () => {
    // If any hop of the chain stops existing — the runner stops being a shell entrypoint that execs the server, the
    // server stops importing the barrel at runtime, the barrel stops re-exporting the vault, or the image stops
    // running with `NODE_ENV=production` — then the two load-safety tests above would still pass while measuring
    // nothing. These are the pins that keep them honest.
    expect(readRepoFile(RUNNER_ENTRYPOINT_PATH)).toContain("node /app/dist/sandbox-runner-server.js");
    expect(readRepoFile(RUNNER_SERVER_PATH)).toContain('from "@npati/workspace"');
    expect(readRepoFile(RUNNER_MOUNT_POLICY_PATH)).toContain('from "@npati/workspace"');
    expect(readRepoFile(WORKSPACE_BARREL_PATH)).toContain('export * from "./crypto-vault"');
    expect(readRepoFile(DOCKERFILE_PATH)).toContain("ENV NODE_ENV=production");
  });

  it("is not vacuous: putting the refusal back into the constructor makes module evaluation throw", () => {
    const source = readRepoFile(VAULT_PATH);
    // An anchor that vanished or moved would make this proof vacuous, so the mutation is only allowed to apply
    // when it matches exactly one line — the discipline the repository's own mutation matrix uses.
    expect(source.split(DEFERRED_REFUSAL_ANCHOR)).toHaveLength(2);
    const eager = source.replace(DEFERRED_REFUSAL_ANCHOR, EAGER_REFUSAL_MUTATION);
    expect(eager).not.toBe(source);

    const saved = snapshotEnvironment();
    try {
      process.env.NODE_ENV = "production";
      delete process.env.NPATI_ENV;
      delete process.env.NPATI_ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;

      // The shipped module evaluates, which is what "loading is safe" claims...
      expect(() => evaluateVaultModule(source)).not.toThrow();
      // ...and the pre-fix behaviour does not: the refusal raised by the constructor is a refusal raised by
      // `import`, which is the CrashLoop. The load-safety assertions above are therefore sensitive to the defect.
      expect(() => evaluateVaultModule(eager)).toThrow("NPATI_ENCRYPTION_KEY_REQUIRED");
    } finally {
      restoreEnvironment(saved);
    }
  });

  it("is not vacuous in the other direction: without the derivation guard a production vault encrypts anyway", () => {
    const source = readRepoFile(VAULT_PATH);
    expect(source.split(DERIVATION_GUARD_ANCHOR)).toHaveLength(2);
    const unguarded = source.replace(DERIVATION_GUARD_ANCHOR, DERIVATION_GUARD_REMOVED);
    expect(unguarded).not.toBe(source);

    const saved = snapshotEnvironment();
    try {
      process.env.NODE_ENV = "production";
      delete process.env.NPATI_ENV;
      delete process.env.NPATI_ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;

      // The security half: this is what "using is refused" is protecting. Without the guard the vault silently
      // falls back to the ambient development key and *produces ciphertext in production*.
      const mutated = evaluateVaultModule(unguarded);
      expect(() => mutated.defaultVault.encrypt("plaintext")).not.toThrow();

      // The shipped module refuses the same call, so the two differ only by the guard.
      const shipped = evaluateVaultModule(source);
      expect(() => shipped.defaultVault.encrypt("plaintext")).toThrow("NPATI_ENCRYPTION_KEY_REQUIRED");
    } finally {
      restoreEnvironment(saved);
    }
  });
});
