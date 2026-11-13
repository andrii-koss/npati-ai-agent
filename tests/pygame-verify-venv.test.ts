import { expect, it } from "vitest";
import { createCodePortsWiring, type CreateCodePortsWiringDeps } from "../apps/agent-api/src/code-ports-wiring";

// V6 step 08: a Pygame project's checks run its .venv. Without one yet, the check creates it once with the Sandbox's system
// packages (pygame has no wheel for the Sandbox's Python; the distribution's build is preinstalled), installs requirements
// and retries, instead of failing with "not found".
it("creates a missing .venv with the system packages and retries the check", async () => {
  const ran: string[] = []; let venv = false;
  const execute = async (_ctx: unknown, _company: string, input: { command: string }) => {
    ran.push(input.command);
    if (input.command.startsWith("python3 -m venv")) { venv = true; return { exitCode: 0, stdout: "" }; }
    if (input.command.startsWith(".venv/bin/python -m unittest") && !venv) throw Object.assign(new Error("sh: .venv/bin/python: not found"), { code: "command_not_found" });
    return { exitCode: 0, stdout: "Ran 23 tests\n\nOK" };
  };
  const ports = createCodePortsWiring({ config: {}, log: { warn() {}, info() {} }, projectSandbox: { execute }, featureFlagService: {}, secretLeases: {},
    projectService: { get: async () => ({ toolchain: { verifyCommands: { test: ".venv/bin/python -m unittest discover -s tests" } } }) },
    projectWorkspace: { listFiles: async () => [] } } as unknown as CreateCodePortsWiringDeps);
  const outcome = await ports.codeVerifyRunnerPort!.run({ ctx: { workspaceId: "w", userId: "u", permissions: [] }, companyId: "c", projectId: "p", tools: ["test"], changedOnly: false, timeoutMs: 60_000 }) as unknown as { results: Array<{ ok: boolean }> };
  expect(ran).toEqual([
    ".venv/bin/python -m unittest discover -s tests",
    "python3 -m venv --system-site-packages .venv",
    "if [ -f requirements.txt ]; then .venv/bin/python -m pip install -r requirements.txt; fi",
    ".venv/bin/python -m unittest discover -s tests",
  ]);
  expect(JSON.stringify(outcome)).toContain("\"ok\":true");
});
