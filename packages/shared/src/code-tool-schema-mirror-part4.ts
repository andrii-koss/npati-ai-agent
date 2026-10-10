/* Part 4 of the code-tool schema mirror, split out of code-capabilities.ts in step 3c of
 * docs/refactoring/PLAN.md. Entries are moved verbatim; code-capabilities.ts spreads the parts back
 * together in this exact order, so the resulting object is unchanged, key order included.
 */

import { resultEnvelope } from "./code-capabilities-shared";

export const CODE_TOOL_SCHEMA_MIRROR_PART4: Record<string, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }> = {
  "code.git.status": {
    inputSchema: { type: "object", required: [], additionalProperties: false, properties: {} },
    outputSchema: resultEnvelope("code.git.status", {
      type: "object",
      required: ["branch", "clean", "staged", "unstaged", "untracked", "truncated", "workspaceRevision"],
      additionalProperties: false,
      properties: {
        branch: { type: "string" },
        clean: { type: "boolean" },
        staged: { type: "array", items: { type: "string" }, maxItems: 500 },
        unstaged: { type: "array", items: { type: "string" }, maxItems: 500 },
        untracked: { type: "array", items: { type: "string" }, maxItems: 500 },
        truncated: { type: "boolean" },
        workspaceRevision: { type: ["string", "null"], description: "Canonical workspace revision the operation ran against." },
      },
    }),
  },
  "code.git.diff": {
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        file: { type: "string", minLength: 1, maxLength: 500, description: "Workspace-relative path; the canonical validator refuses traversal, absolute and secret paths." },
        staged: { type: "boolean", default: false, description: "Diff the index against HEAD instead of the worktree against the index." },
      },
    },
    outputSchema: resultEnvelope("code.git.diff", {
      type: "object",
      required: ["diff", "truncated", "files", "workspaceRevision"],
      additionalProperties: false,
      properties: {
        diff: { type: "string" },
        truncated: { type: "boolean" },
        files: { type: "array", items: { type: "string" }, maxItems: 500 },
        workspaceRevision: { type: ["string", "null"], description: "Canonical workspace revision the operation ran against." },
      },
    }),
  },
  "code.git.log": {
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
    },
    outputSchema: resultEnvelope("code.git.log", {
      type: "object",
      required: ["entries", "count"],
      additionalProperties: false,
      properties: {
        entries: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            required: ["hash", "author", "date", "message"],
            additionalProperties: false,
            properties: {
              hash: { type: "string" },
              author: { type: "string" },
              date: { type: "string" },
              message: { type: "string" },
            },
          },
        },
        count: { type: "integer" },
      },
    }),
  },
  "code.git.branch.create": {
    inputSchema: {
      type: "object",
      required: ["branch"],
      additionalProperties: false,
      properties: { branch: { type: "string", minLength: 1, maxLength: 100, description: "Branch to create. `..`, `@{`, a trailing `.lock` and an empty name are refused." } },
    },
    outputSchema: resultEnvelope("code.git.branch.create", {
      type: "object",
      required: ["branch", "created", "workspaceRevision"],
      additionalProperties: false,
      properties: {
        branch: { type: "string" },
        created: { type: "boolean" },
        workspaceRevision: { type: ["string", "null"], description: "Canonical workspace revision the operation ran against." },
      },
    }),
  },
  "code.git.branch.switch": {
    inputSchema: {
      type: "object",
      required: ["branch"],
      additionalProperties: false,
      properties: { branch: { type: "string", minLength: 1, maxLength: 100, description: "Existing branch to check out." } },
    },
    outputSchema: resultEnvelope("code.git.branch.switch", {
      type: "object",
      required: ["branch", "previousBranch", "switched"],
      additionalProperties: false,
      properties: {
        branch: { type: "string" },
        previousBranch: { type: ["string", "null"] },
        switched: { type: "boolean" },
      },
    }),
  },
  "code.git.stage": {
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        files: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 500 }, description: "Paths to stage. Omit to stage every change." },
      },
    },
    outputSchema: resultEnvelope("code.git.stage", {
      type: "object",
      required: ["staged", "stagedCount"],
      additionalProperties: false,
      properties: {
        staged: { type: "array", items: { type: "string" }, maxItems: 500 },
        stagedCount: { type: "integer" },
      },
    }),
  },
  "code.git.commit": {
    inputSchema: {
      type: "object",
      required: ["message"],
      additionalProperties: false,
      properties: {
        message: { type: "string", minLength: 1, maxLength: 2000 },
        files: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 500 }, description: "Paths to commit. Omit with stageAll to commit what is already staged." },
        stageAll: { type: "boolean", default: false, description: "Stage every change before committing." },
      },
    },
    outputSchema: resultEnvelope("code.git.commit", {
      type: "object",
      required: ["commitHash", "message", "branch", "stagedCount", "workspaceRevision"],
      additionalProperties: false,
      properties: {
        commitHash: { type: "string" },
        message: { type: "string" },
        branch: { type: "string" },
        stagedCount: { type: "integer" },
        workspaceRevision: { type: ["string", "null"], description: "Canonical workspace revision the operation ran against." },
      },
    }),
  },
  "code.git.restore": {
    inputSchema: {
      type: "object",
      required: ["files"],
      additionalProperties: false,
      properties: {
        files: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", minLength: 1, maxLength: 500 }, description: "Paths whose working-tree changes are discarded. Empty is refused." },
      },
    },
    outputSchema: resultEnvelope("code.git.restore", {
      type: "object",
      required: ["restored", "restoredCount"],
      additionalProperties: false,
      properties: {
        restored: { type: "array", items: { type: "string" }, maxItems: 500 },
        restoredCount: { type: "integer" },
      },
    }),
  },
  "code.git.push": {
    inputSchema: {
      type: "object",
      required: ["targetBranch", "credentialId"],
      additionalProperties: false,
      properties: {
        targetBranch: { type: "string", minLength: 1, maxLength: 100, description: "The branch on the remote this push writes. Required: without a named target the protected-branch policy has nothing to judge." },
        sourceBranch: { type: "string", minLength: 1, maxLength: 100, description: "The local branch to publish. Defaults to targetBranch." },
        credentialId: { type: "string", minLength: 1, maxLength: 100, description: "Company vault credential reference for this one operation; the value never reaches the model or the result." },
        force: { type: "boolean", default: false, description: "Ask for a history rewrite. A protected branch answers force_push_denied; any other branch is refused as unsupported." },
      },
    },
    outputSchema: resultEnvelope("code.git.push", {
      type: "object",
      required: ["pushed", "branch", "remoteBranch", "force"],
      additionalProperties: false,
      properties: {
        pushed: { type: "boolean" },
        branch: { type: "string" },
        remoteBranch: { type: "string" },
        force: { type: "boolean" },
      },
    }),
  },
  "code.git.pr.create": {
    inputSchema: {
      type: "object",
      required: ["title", "base", "head", "credentialId"],
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 300 },
        body: { type: "string", maxLength: 60000, description: "Body. Omit to reuse the run summary (what changed, verification, risks, unresolved items)." },
        base: { type: "string", minLength: 1, maxLength: 100, description: "The branch the pull request targets." },
        head: { type: "string", minLength: 1, maxLength: 100, description: "The branch under review." },
        credentialId: { type: "string", minLength: 1, maxLength: 100, description: "Company vault credential reference for this one operation; the value never reaches the model or the result." },
      },
    },
    outputSchema: resultEnvelope("code.git.pr.create", {
      type: "object",
      required: ["prNumber", "prUrl", "base", "head", "created", "descriptionSource"],
      additionalProperties: false,
      properties: {
        prNumber: { type: ["integer", "null"] },
        prUrl: { type: ["string", "null"] },
        base: { type: "string" },
        head: { type: "string" },
        created: { type: "boolean" },
        descriptionSource: { type: "string", enum: ["caller", "run_summary", "unavailable"] },
      },
    }),
  },
  "code.git.pr.comment": {
    inputSchema: {
      type: "object",
      required: ["pullNumber", "body", "credentialId"],
      additionalProperties: false,
      properties: {
        pullNumber: { type: "integer", minimum: 1, maximum: 1000000 },
        body: { type: "string", minLength: 1, maxLength: 60000 },
        credentialId: { type: "string", minLength: 1, maxLength: 100, description: "Company vault credential reference for this one operation; the value never reaches the model or the result." },
      },
    },
    outputSchema: resultEnvelope("code.git.pr.comment", {
      type: "object",
      required: ["commentId", "commentUrl", "pullNumber", "created"],
      additionalProperties: false,
      properties: {
        commentId: { type: ["integer", "null"] },
        commentUrl: { type: ["string", "null"] },
        pullNumber: { type: "integer" },
        created: { type: "boolean" },
      },
    }),
  },
  /**
   * C12: the delegation tool. It is a **metadata** tool like the git adapters — the child's transcript,
   * file bodies and tool output never travel back — which is why its result schema is a bounded handoff
   * digest rather than a nested run result.
   */
  "code.agent.spawn": {
    inputSchema: {
      type: "object",
      required: ["agentType", "task"],
      additionalProperties: false,
      properties: {
        agentType: { enum: ["explore", "plan", "implement", "review", "test"], description: "The kind of sub-agent. It decides the child's model profile, turn limit and capability profile." },
        task: { type: "string", minLength: 1, maxLength: 8000, description: "A self-contained task. The child sees this text, not this run's conversation." },
        paths: { type: "array", maxItems: 20, items: { type: "string", maxLength: 1024 }, description: "Workspace-relative file or directory scope for the child. Each path passes the canonical path guard, so absolute, traversing and secret paths are refused." },
        tools: { type: "array", maxItems: 64, items: { type: "string", maxLength: 128 }, description: "Tools requested for the child. A request is never a grant: the effective set is the intersection of this run's effective tools, the child type's profile and this list, resolved against the published registry. A wildcard resolves only against that registry." },
        model: { type: "string", maxLength: 200, description: "Optional model override. The child type's model profile still applies, so an override cannot remove its constraints." },
        turnLimit: { type: "integer", minimum: 1, maximum: 40, description: "Requested cap on the child's model turns. Clamped down to the child type's limit, which is itself clamped to the canonical ceiling: configuration may lower it, never raise it." },
        summaryOnly: { type: "boolean", default: true, description: "Return the metadata-only handoff digest. It is the only result this tool produces, so `false` is refused with `subagent_summary_required` instead of being silently ignored." },
      },
    },
    outputSchema: resultEnvelope("code.agent.spawn", {
      type: "object",
      required: ["agentType", "status", "runId", "capabilityProfile", "limits", "tools", "handoff", "truncated"],
      additionalProperties: false,
      properties: {
        agentType: { enum: ["explore", "plan", "implement", "review", "test"] },
        status: { enum: ["completed", "failed"] },
        runId: { type: ["string", "null"] },
        errorCode: { type: ["string", "null"] },
        capabilityProfile: { type: "string" },
        limits: {
          type: "object",
          required: ["maxTurns", "maxParallelism"],
          additionalProperties: false,
          properties: {
            maxTurns: { type: "integer" },
            maxParallelism: { type: "integer" },
          },
        },
        tools: { type: "array", maxItems: 64, items: { type: "string" } },
        handoff: {
          type: "object",
          required: ["schemaVersion", "findings", "files", "symbols", "toolCalls", "turns", "dropped"],
          additionalProperties: false,
          properties: {
            schemaVersion: { type: "integer" },
            findings: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                required: ["kind", "path", "name", "detail"],
                additionalProperties: false,
                properties: {
                  kind: { enum: ["fact", "file", "symbol", "risk", "open_question"] },
                  path: { type: ["string", "null"] },
                  name: { type: ["string", "null"] },
                  detail: { type: "string", maxLength: 200 },
                },
              },
            },
            files: { type: "array", maxItems: 200, items: { type: "string" } },
            symbols: {
              type: "array",
              maxItems: 200,
              items: {
                type: "object",
                required: ["path", "name", "kind"],
                additionalProperties: false,
                properties: {
                  path: { type: "string" },
                  name: { type: "string" },
                  kind: { type: "string" },
                },
              },
            },
            toolCalls: { type: "integer" },
            turns: { type: "integer" },
            dropped: { type: "integer" },
          },
        },
        truncated: { type: "boolean" },
      },
    }),
  },
};
