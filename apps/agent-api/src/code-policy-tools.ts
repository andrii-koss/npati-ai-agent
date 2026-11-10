import type { AuthContext } from "@npati/workspace";
import {
  CODE_READ_CAPABILITIES,
  CODE_SHELL_CAPABILITIES,
  CODE_WRITE_CAPABILITIES,
  CODE_DEPS_CAPABILITIES,
} from "@npati/shared";
import { hasAdminPermission, type CodeCanonicalSessionMode } from "./code-rbac";
import { MCP_FLAG as MCP_RUNTIME_FLAG, isRuntimeMcpTool } from "./mcp-runtime-identity";
import { isGitWriteTool } from "./code-git-write-policy";

export type PolicyDecision = "allow" | "deny" | "require_approval";
export type PolicyRisk = "safe" | "controlled" | "approval" | "hard_deny";

/**
 * The reason an approval-classed request carries when it is deferred to a stronger boundary
 * (`approvalDeferredByBoundary`). It is exported because C13's PreToolUse probe reuses the same deferral to
 * ask the engine a question *without side effects* — the approval phase would otherwise create a second
 * approval request for the same call — and then reads this marker to recognise "an approval would be
 * required", which must withhold a project hook rather than let it run on an approval-required path.
 */
export const APPROVAL_DEFERRED_REASON = "approval:deferred_to_boundary";

export const MASTER_FLAG = "coding_agent.enabled";
export const READ_FLAG = "code.read";
export const WRITE_FLAG = "code.write";
export const SHELL_FLAG = "code.shell";
/**
 * C11: git tooling has its own declared sub-flag (`feature-flags.ts`, off by default) and its own
 * capability group (`code-capability-groups.ts`). Before C11 the sub-flag existed while the mapping sent
 * every git tool to `code.write`, so enabling "writes" silently enabled git tooling too — the flag was
 * decorative. Git tools are named here so the mapping and the flag agree.
 */
export const GIT_FLAG = "code.git";
/**
 * C13 (owner decision 5): the sub-flag that gates **runtime MCP tools**. `code.mcp` has existed in
 * `CODE_AGENT_SUB_FLAGS` and in `CODE_FLAG_KEY_PATTERN` since the flag list was written, but nothing read it —
 * a flag that is settable and inert is worse than a missing one, because an operator who turns it off believes
 * something changed. It is its own flag rather than `code.write` because calling a third-party MCP server is a
 * different blast radius from editing a file: a workspace may want agent edits while forbidding outbound
 * server calls entirely.
 */
export const MCP_FLAG = MCP_RUNTIME_FLAG;

/**
 * Tools whose capability declaration demands a human approval. Derived from the shared capability
 * catalog so there is exactly one definition (a capability that declares `requiresConfirmation` must
 * be approved regardless of the command risk class).
 */
export const APPROVAL_GATED_TOOLS = new Set(
  [...CODE_READ_CAPABILITIES, ...CODE_WRITE_CAPABILITIES, ...CODE_SHELL_CAPABILITIES, ...CODE_DEPS_CAPABILITIES]
    .filter((capability) => capability.requiresConfirmation === true)
    .map((capability) => capability.id),
);

/** The normalized modes of the owner's decision matrix. One definition, shared with `code-rbac.ts`. */
export type MatrixMode = CodeCanonicalSessionMode;

/**
 * Owner matrix: mode x risk. `hard_deny` is denied in every mode (phase 4 returns first, this row is
 * the documented backstop). The C1 session modes map onto these as:
 * plan -> plan, edit -> ask, auto -> auto_edit, full_auto -> full_auto_sandbox (mapping to confirm).
 */
export const MODE_RISK_MATRIX: Record<MatrixMode, Record<PolicyRisk, PolicyDecision>> = {
  plan: { safe: "allow", controlled: "deny", approval: "deny", hard_deny: "deny" },
  ask: { safe: "allow", controlled: "require_approval", approval: "require_approval", hard_deny: "deny" },
  auto_edit: { safe: "allow", controlled: "allow", approval: "require_approval", hard_deny: "deny" },
  full_auto_sandbox: { safe: "allow", controlled: "allow", approval: "require_approval", hard_deny: "deny" },
};

export function matrixModeFor(mode: string | null | undefined): MatrixMode {
  switch (mode) {
    case "plan": return "plan";
    case "edit": return "ask";
    case "ask": return "ask";
    case "auto": return "auto_edit";
    case "auto_edit": return "auto_edit";
    case "full_auto": return "full_auto_sandbox";
    case "full_auto_sandbox": return "full_auto_sandbox";
    default: return "plan";
  }
}

export const READ_TOOLS = new Set([
  // Manifest v15: viewing, documentation lookup and Data Studio reads. None touches the workspace or the dev data.
  "code.image.view", "code.preview.screenshot", "code.web.fetch", "code.web.search",
  "code.data.query.read", "code.data.migrations.list", "code.data.policies.inspect",
  "code.data.schema.inspect",
  "code.data.rows.list",
  "code.fs.read", "code.fs.list", "code.fs.grep", "code.fs.tree",
  "code.symbols.outline", "code.project.info", "code.fs.diff",
  "code.shell.process.list", "code.shell.process.logs", "code.shell.process.wait",
]);

/**
 * C9 narrow planning allowance — an explicit **name list**, deliberately not a membership in `READ_TOOLS`.
 *
 * These tools carry session metadata (a plan draft, the todo list) or a question to the user. None of them
 * can touch the workspace, the sandbox or the network, which is why `plan` mode has to allow them. But
 * read-only is a *broad* class that grows every time a read tool is published, and plan mode must not
 * inherit that growth: with `isReadOnlyTool` as the gate, any future read tool would silently become
 * available in the one mode whose entire purpose is to plan without touching code. The owner's decision is
 * therefore a narrow, reviewable list, read by the same three places that used to read the class — the
 * `plan` branch below, the runner's offered-tool filter, and the sub-flag/permission mapping.
 */
export const PLAN_SAFE_TOOLS = new Set(["code.plan.propose", "code.plan.update", "code.ask_user", "code.finish"]);

/**
 * C11 (owner decision 10): the tools a **read-only intent** may call beyond the reads and the plan-safe
 * metadata tools.
 *
 * `code.git.status/diff/log` write nothing — not the working tree, not the index, not the remote — so a
 * review may inspect history and the change set. `code.git.pr.comment` is here for the other half of the
 * owner's decision: a review's finding belongs on the pull request, and posting it is *not* a repository
 * write, so it is permitted — but only through **its own** approval record, bound to the pull-request number
 * and a hash of the comment text (`gitToolApprovalPayload`). An approval for a push or for opening a pull
 * request cannot be redeemed as a comment, because the payloads differ.
 */
export const REVIEW_SAFE_GIT_TOOLS = new Set(["code.git.status", "code.git.diff", "code.git.log", "code.git.pr.comment"]);

export const SHELL_TOOLS = new Set(["code.shell.exec_async", "code.shell.exec", "code.shell.process.start", "code.shell.process.stop"]);
export const WRITE_TOOLS = new Set([
  "code.preview.restart",
  "code.data.rows.seed",
  "code.data.users.roles.set",
  "code.data.policies.apply",
  "code.data.backend.create",
  "code.data.schema.apply",
  "code.data.schema.modify",
  "code.data.rows.transfer",
  "code.data.backend.attach",
  "code.fs.edit", "code.fs.apply_patch", "code.fs.write", "code.fs.move",
  "code.fs.delete", "code.fs.undo_last_turn", "code.verify.run",
]);

/** Exported for tests and for the wiring layer, so the mapping has exactly one definition. */
export function subFlagForTool(tool: string): string {
  // C13: a runtime MCP tool is gated by `code.mcp`. Checked first because the id space (`mcp:<connection>/<tool>`)
  // is disjoint from every static one, so there is no ordering question to get wrong.
  if (isRuntimeMcpTool(tool)) return MCP_FLAG;
  // Every shell capability (including the read-only process list/logs) is gated by the dedicated
  // `code.shell` sub-flag, so an operator can forbid command execution while still allowing edits.
  if (tool.startsWith("code.shell.")) return SHELL_FLAG;
  if (tool === "code.preview.restart") return SHELL_FLAG;
  if (SHELL_TOOLS.has(tool)) return SHELL_FLAG;
  // C11: a git write is gated by the git sub-flag, not by `code.write`. Both are off by default, but
  // they are different blast radii: enabling file edits must not enable pushing to a remote.
  if (tool.startsWith("code.git.") || isGitWriteTool(tool)) return GIT_FLAG;
  if (READ_TOOLS.has(tool)) return READ_FLAG;
  // Plan/question tools never touch the workspace, so they follow the read flag rather than the write flag:
  // gating a *question* behind "writes allowed" would push the agent to guess instead of asking.
  if (PLAN_SAFE_TOOLS.has(tool)) return READ_FLAG;
  return WRITE_FLAG;
}

export function permissionForTool(tool: string): "workspace:read" | "workspace:write" {
  // Plan/question tools act on session metadata only, so the minimum workspace permission is a read — the
  // same level their capability records declare. Requiring `workspace:write` here would be stricter than
  // the tool's blast radius and would contradict the catalogue. The read-only git tools only read the
  // repository's state, so they are reads too.
  //
  // C13: a runtime MCP tool is neither, and it is deliberately mapped to the **stricter** of the two. It is not
  // derived from the tool name (an MCP tool called `read_file` is a claim by a third-party server, and a claim
  // is not a permission), so it can only be reached by a principal that already holds `workspace:write` or
  // `admin:all`.
  return READ_TOOLS.has(tool) || PLAN_SAFE_TOOLS.has(tool) || REVIEW_SAFE_GIT_TOOLS.has(tool)
    ? "workspace:read"
    : "workspace:write";
}

/**
 * `isReadOnlyTool` keeps its original meaning — the C2/C3 `READ_TOOLS` class — because `plan` mode reads it:
 * a git read tool must not become available in `plan` merely by being read-only. The read-only *git* class
 * is `REVIEW_SAFE_GIT_TOOLS`, and only the review gate below consults it.
 */
export function isReadOnlyTool(tool: string): boolean { return READ_TOOLS.has(tool); }
export function isShellTool(tool: string): boolean { return SHELL_TOOLS.has(tool); }
export function isPlanSafeTool(tool: string): boolean { return PLAN_SAFE_TOOLS.has(tool); }

/**
 * C11 (owner decision 10): the complete set of tools a **read-only intent** may call. It is the union of the
 * three narrow lists the engine already keeps — the read tools, the plan-safe metadata tools and the
 * read-only git tools — so "read-only" has exactly one definition and a new tool cannot join it by accident.
 */
export function isReviewSafeTool(tool: string): boolean {
  return READ_TOOLS.has(tool) || PLAN_SAFE_TOOLS.has(tool) || REVIEW_SAFE_GIT_TOOLS.has(tool);
}

export function isAdmin(ctx: AuthContext): boolean {
  // C5a: one definition of the admin vocabulary, shared with `code-rbac.ts`.
  return hasAdminPermission(ctx.permissions);
}

/**
 * An agent (or an agent token) must never be an approver. Principals that identify themselves as
 * agents are recognised conservatively: any doubt resolves to "agent".
 */
export function isAgentPrincipal(ctx: AuthContext): boolean {
  const subject = String(ctx.externalSubject ?? "");
  const userId = String(ctx.userId ?? "");
  return subject.startsWith("agent:") || subject.startsWith("service:") || userId.startsWith("agent:");
}

/** Network-capable executables: denied until C4b guarantees egress enforcement. */
export const NETWORK_EXECUTABLES = new Set([
  "curl", "wget", "ssh", "scp", "sftp", "nc", "netcat", "telnet", "ftp", "ping", "dig", "nslookup",
]);

export const NETWORK_SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(["install", "i", "add", "ci", "publish", "audit", "update", "exec"]),
  pnpm: new Set(["install", "i", "add", "publish", "update", "dlx"]),
  yarn: new Set(["install", "add", "publish", "up", "upgrade"]),
  pip: new Set(["install", "download"]),
  pip3: new Set(["install", "download"]),
  poetry: new Set(["install", "add", "update"]),
  uv: new Set(["pip", "sync", "add"]),
  go: new Set(["get", "install", "mod"]),
  cargo: new Set(["install", "add", "update", "publish"]),
  git: new Set(["clone", "fetch", "pull", "push", "remote", "submodule", "ls-remote"]),
  docker: new Set(["pull", "push", "login"]),
  apt: new Set(["install", "update"]),
  aptget: new Set(["install", "update"]),
  gem: new Set(["install"]),
  composer: new Set(["require", "install", "update"]),
};

export function isNetworkCommand(command: string): boolean {
  const text = command.replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (/https?:\/\//i.test(text)) return true;
  // Split on shell separators, then look at the first word (and subcommand) of each segment.
  for (const segment of text.split(/\|\||&&|;|\|/)) {
    const words = segment.trim().split(" ").filter(Boolean);
    // Skip leading VAR=value assignments and wrappers such as `npx`/`sudo`.
    let index = 0;
    while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!) || words[index] === "sudo" || words[index] === "npx" || words[index] === "env")) index += 1;
    const executable = (words[index] ?? "").split("/").pop() ?? "";
    const subcommand = words[index + 1] ?? "";
    if (NETWORK_EXECUTABLES.has(executable)) return true;
    if (NETWORK_SUBCOMMANDS[executable]?.has(subcommand)) return true;
  }
  return false;
}

/** Conservative built-in path safety used when no canonical guard is injected. */
export function isUnsafePath(path: string): boolean {
  if (!path || path.includes("\0")) return true;
  const normalised = path.replace(/\\/g, "/");
  if (normalised.startsWith("/") || /^[A-Za-z]:\//.test(normalised) || normalised.startsWith("~")) return true;
  return normalised.split("/").includes("..");
}
