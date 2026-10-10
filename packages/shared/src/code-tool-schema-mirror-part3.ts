/* Part 3 of the code-tool schema mirror, split out of code-capabilities.ts in step 3c of
 * docs/refactoring/PLAN.md. Entries are moved verbatim; code-capabilities.ts spreads the parts back
 * together in this exact order, so the resulting object is unchanged, key order included.
 */

import { resultEnvelope } from "./code-capabilities-shared";

export const CODE_TOOL_SCHEMA_MIRROR_PART3: Record<string, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }> = {
  "code.fs.apply_patch": {
    inputSchema: {
      type: "object",
      required: ["patch"],
      additionalProperties: false,
      properties: {
        patch: { type: "string", minLength: 1, maxLength: 1000000, description: "Unified diff (---/+++/@@ hunks) with workspace-relative paths." },
        dryRun: { type: "boolean", default: false },
      },
    },
    outputSchema: resultEnvelope("code.fs.apply_patch", {
      type: "object",
      required: ["applied", "dryRun", "diff"],
      additionalProperties: false,
      properties: {
        applied: { type: "array", items: { type: "string" } },
        dryRun: { type: "boolean" },
        diff: { type: "string" },
        failed: { type: ["array", "null"], items: { type: "object", additionalProperties: true } },
      },
    }),
  },
  "code.fs.write": {
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        content: { type: "string", maxLength: 1000000 },
        createDirectories: { type: "boolean", default: true },
        overwrite: { type: "boolean", default: true, description: "When false, refuse to replace an existing file." },
      },
    },
    outputSchema: resultEnvelope("code.fs.write", {
      type: "object",
      required: ["path", "created", "bytes", "sha256", "encoding", "eol", "diff"],
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        created: { type: "boolean" },
        bytes: { type: "integer" },
        sha256: { type: "string" },
        encoding: { type: "string" },
        eol: { type: "string" },
        diff: { type: "string" },
      },
    }),
  },
  "code.fs.move": {
    inputSchema: {
      type: "object",
      required: ["from", "to"],
      additionalProperties: false,
      properties: {
        from: { type: "string", description: "Existing workspace-relative path." },
        to: { type: "string", description: "Destination workspace-relative path." },
        overwrite: { type: "boolean", default: false },
      },
    },
    outputSchema: resultEnvelope("code.fs.move", {
      type: "object",
      required: ["from", "to", "moved"],
      additionalProperties: false,
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        moved: { type: "boolean" },
      },
    }),
  },
  "code.fs.delete": {
    inputSchema: {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Workspace-relative path to delete." },
        recursive: { type: "boolean", default: false, description: "Required to delete a non-empty directory." },
        expectedRevision: { type: "string", description: "Optional sha256 the caller expects the target to still have; a mismatch refuses the delete." },
      },
    },
    outputSchema: resultEnvelope("code.fs.delete", {
      type: "object",
      required: ["path", "deleted", "recursive"],
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        deleted: { type: "boolean" },
        recursive: { type: "boolean" },
      },
    }),
  },
  "code.fs.diff": {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Optional workspace-relative path to limit the diff to." },
        turnOnly: { type: "boolean", default: true, description: "Limit the diff to changes made in the current turn." },
        maxFiles: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
    },
    outputSchema: resultEnvelope("code.fs.diff", {
      type: "object",
      required: ["files", "stats"],
      additionalProperties: false,
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "status", "additions", "deletions"],
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              status: { enum: ["added", "modified", "deleted", "renamed"] },
              additions: { type: "integer" },
              deletions: { type: "integer" },
              diff: { type: "string" },
            },
          },
        },
        stats: {
          type: "object",
          required: ["files", "additions", "deletions"],
          additionalProperties: false,
          properties: {
            files: { type: "integer" },
            additions: { type: "integer" },
            deletions: { type: "integer" },
          },
        },
      },
    }),
  },
  "code.fs.undo_last_turn": {
    inputSchema: {
      type: "object",
      required: ["confirm"],
      additionalProperties: false,
      properties: {
        confirm: { type: "boolean", enum: [true], description: "Must be true: the caller confirms it wants the turn rolled back." },
      },
    },
    outputSchema: resultEnvelope("code.fs.undo_last_turn", {
      type: "object",
      required: ["restored", "checkpointId"],
      additionalProperties: false,
      properties: {
        restored: { type: "array", items: { type: "string" } },
        checkpointId: { type: "string" },
      },
    }),
  },
  "code.shell.exec": {
    inputSchema: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: {
        command: { type: "string", minLength: 1, maxLength: 4000, description: "The command line to run in the sandbox. Interactive commands and commands needing production credentials are refused." },
        cwd: { type: "string", description: "Workspace-relative working directory; defaults to the workspace root." },
        env: { type: "object", additionalProperties: { type: "string" }, description: "Non-secret environment variables. Secrets must be requested through secretRefs instead." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000, default: 120000 },
        secretRefs: { type: "array", items: { type: "string" }, maxItems: 10, description: "Names of company vault secrets to lease for exactly this call. The lease is revoked when the call ends and is never inherited." },
        approved: { type: "boolean", default: false, description: "Set by the runtime after the approval system granted this exact command; never set it from model output." },
      },
    },
    outputSchema: resultEnvelope("code.shell.exec", {
      type: "object",
      required: ["exitCode", "stdout", "stderr", "durationMs", "truncated", "risk"],
      additionalProperties: false,
      properties: {
        exitCode: { type: ["integer", "null"] },
        stdout: { type: "string" },
        stderr: { type: "string" },
        durationMs: { type: "integer" },
        truncated: { type: "boolean" },
        risk: { enum: ["low", "medium", "high"] },
      },
    }),
  },
  "code.shell.process.start": {
    inputSchema: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: {
        command: { type: "string", minLength: 1, maxLength: 4000 },
        cwd: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
        approved: { type: "boolean", default: false },
      },
    },
    outputSchema: resultEnvelope("code.shell.process.start", {
      type: "object",
      required: ["processId", "startedAt"],
      additionalProperties: false,
      properties: {
        processId: { type: "string" },
        startedAt: { type: "string" },
      },
    }),
  },
  "code.shell.process.list": {
    inputSchema: { type: "object", required: [], additionalProperties: false, properties: {} },
    outputSchema: resultEnvelope("code.shell.process.list", {
      type: "object",
      required: ["processes"],
      additionalProperties: false,
      properties: {
        processes: {
          type: "array",
          items: {
            type: "object",
            required: ["processId", "command", "status"],
            additionalProperties: false,
            properties: {
              processId: { type: "string" },
              command: { type: "string" },
              status: { enum: ["running", "stopped", "failed"] },
              startedAt: { type: ["string", "null"] },
              exitCode: { type: ["integer", "null"] },
            },
          },
        },
      },
    }),
  },
  "code.shell.process.logs": {
    inputSchema: {
      type: "object",
      required: ["processId"],
      additionalProperties: false,
      properties: {
        processId: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 2000, default: 200 },
      },
    },
    outputSchema: resultEnvelope("code.shell.process.logs", {
      type: "object",
      required: ["lines", "nextOffset", "eof"],
      additionalProperties: false,
      properties: {
        lines: { type: "array", items: { type: "string" } },
        nextOffset: { type: "integer" },
        eof: { type: "boolean" },
      },
    }),
  },
  "code.shell.process.stop": {
    inputSchema: {
      type: "object",
      required: ["processId"],
      additionalProperties: false,
      properties: {
        processId: { type: "string", minLength: 1 },
      },
    },
    outputSchema: resultEnvelope("code.shell.process.stop", {
      type: "object",
      required: ["processId", "stopped"],
      additionalProperties: false,
      properties: {
        processId: { type: "string" },
        stopped: { type: "boolean" },
      },
    }),
  },
  "code.verify.run": {
    inputSchema: {
      type: "object",
      required: ["tools"],
      additionalProperties: false,
      properties: {
        tools: { type: "array", minItems: 1, maxItems: 4, items: { enum: ["lint", "typecheck", "test", "build"] } },
        changedOnly: { type: "boolean", default: false, description: "Verify only the files changed in this turn where the tool supports it." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000, default: 600000 },
      },
    },
    outputSchema: resultEnvelope("code.verify.run", {
      type: "object",
      required: ["results", "stats"],
      additionalProperties: false,
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            required: ["tool", "ok", "summary", "findings"],
            additionalProperties: false,
            properties: {
              tool: { enum: ["lint", "typecheck", "test", "build"] },
              ok: { type: "boolean" },
              summary: { type: "string" },
              findings: { type: "array", items: { type: "string" } },
              raw: { type: "string" },
            },
          },
        },
        stats: {
          type: "object",
          required: ["tools", "passed", "failed", "durationMs"],
          additionalProperties: false,
          properties: {
            tools: { type: "integer" },
            passed: { type: "integer" },
            failed: { type: "integer" },
            durationMs: { type: "integer" },
          },
        },
      },
    }),
  },
  "code.deps.inspect": {
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Workspace-relative manifest or lockfile path; defaults to the detected one." },
        manager: { type: "string", enum: ["npm", "pnpm", "yarn", "pip", "poetry", "uv", "go", "cargo", "composer", "bundler", "maven", "gradle"], description: "Restrict the inspection to one package manager; detection is used when omitted." },
      },
    },
    outputSchema: resultEnvelope("code.deps.inspect", {
      type: "object",
      required: ["manager", "lockfile", "declared"],
      additionalProperties: false,
      properties: {
        manager: { type: "string" },
        lockfile: { type: ["string", "null"] },
        declared: {
          type: "array",
          items: {
            type: "object",
            required: ["name"],
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              version: { type: ["string", "null"] },
              scope: { type: "string", enum: ["runtime", "dev", "peer", "optional", "unknown"] },
              source: { type: ["string", "null"] },
            },
          },
        },
        metadata: { type: "object", additionalProperties: true },
      },
    }),
  },
  "code.deps.audit": {
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        manager: { type: "string", enum: ["npm", "pnpm", "yarn", "pip", "poetry", "uv", "go", "cargo", "composer", "bundler", "maven", "gradle"] },
        lockfilePath: { type: "string", description: "Workspace-relative lockfile to audit; defaults to the detected one." },
        blockOn: {
          type: "array",
          items: { type: "string", enum: ["critical", "high", "moderate", "low"] },
          description: "Severities that make the audit result blocked; defaults to critical and high.",
        },
      },
    },
    outputSchema: resultEnvelope("code.deps.audit", {
      type: "object",
      required: ["report", "blocked"],
      additionalProperties: false,
      properties: {
        report: {
          type: "object",
          required: ["critical", "high", "moderate", "low", "advisories"],
          additionalProperties: false,
          properties: {
            critical: { type: "integer" },
            high: { type: "integer" },
            moderate: { type: "integer" },
            low: { type: "integer" },
            advisories: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  package: { type: "string" },
                  severity: { type: "string" },
                  title: { type: "string" },
                  url: { type: "string" },
                },
              },
            },
          },
        },
        blocked: { type: "boolean" },
        reason: { type: "string" },
      },
    }),
  },
  "code.deps.add": {
    inputSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 214 },
        version: { type: "string", description: "Version or range; the resolved exact version is reported back." },
        manager: { type: "string", enum: ["npm", "pnpm", "yarn", "pip", "poetry", "uv", "go", "cargo", "composer", "bundler", "maven", "gradle"] },
        dev: { type: "boolean", default: false, description: "Add as a development dependency." },
        source: { type: "string", enum: ["registry", "git", "tarball", "http", "local_path"], default: "registry", description: "Where the dependency comes from. Anything other than registry requires an approval." },
      },
    },
    outputSchema: resultEnvelope("code.deps.add", {
      type: "object",
      required: ["manager", "name", "source", "verdict", "reasons"],
      additionalProperties: false,
      properties: {
        manager: { type: "string" },
        name: { type: "string" },
        version: { type: ["string", "null"] },
        source: { type: "string" },
        verdict: { type: "string", enum: ["added", "require_approval", "denied"] },
        reasons: { type: "array", items: { type: "string" } },
        metadata: { type: "object", additionalProperties: true },
        approvalId: { type: ["string", "null"] },
      },
    }),
  },
  "code.plan.propose": {
    inputSchema: {
      type: "object",
      required: ["steps"],
      additionalProperties: false,
      properties: {
        files: {
          type: "array",
          maxItems: 200,
          items: { type: "string", minLength: 1, maxLength: 4096 },
          description: "Workspace-relative paths the plan expects to change, so the reviewer sees the blast radius before approving.",
        },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 4096 },
          description: "Ordered steps. When the plan is approved these become the session todo list.",
        },
        risks: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 4096 } },
        testStrategy: { type: "string", maxLength: 4000 },
      },
    },
    outputSchema: resultEnvelope("code.plan.propose", {
      type: "object",
      required: ["planRevision", "status", "steps"],
      additionalProperties: false,
      properties: {
        planRevision: { type: "integer" },
        status: { type: "string" },
        steps: { type: "integer" },
      },
    }),
  },
  "code.plan.update": {
    inputSchema: {
      type: "object",
      required: ["tasks"],
      additionalProperties: false,
      properties: {
        tasks: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            required: ["taskId", "content", "status"],
            additionalProperties: false,
            properties: {
              taskId: { type: "string", minLength: 1, maxLength: 128 },
              content: { type: "string", minLength: 1, maxLength: 2000 },
              status: { enum: ["pending", "in_progress", "completed"] },
            },
          },
          description: "The complete todo list. States are exactly pending, in_progress and completed.",
        },
      },
    },
    outputSchema: resultEnvelope("code.plan.update", {
      type: "object",
      required: ["tasks", "pending", "inProgress", "completed"],
      additionalProperties: false,
      properties: {
        tasks: { type: "integer" },
        pending: { type: "integer" },
        inProgress: { type: "integer" },
        completed: { type: "integer" },
      },
    }),
  },
  "code.ask_user": {
    inputSchema: {
      type: "object",
      required: ["prompt"],
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description: "The question, in the user's language. State what is being decided and why the answer changes what happens next; the row stores this text verbatim.",
        },
        choices: {
          type: "array",
          maxItems: 10,
          description: "Options the user may pick from. Every option needs a stable id (that is what comes back) and a label (that is only displayed). Omit to ask for a free-form answer, which then requires allowFreeAnswer.",
          items: {
            type: "object",
            required: ["id", "label"],
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1, maxLength: 128 },
              label: { type: "string", minLength: 1, maxLength: 500 },
              description: { type: "string", maxLength: 1000 },
            },
          },
        },
        allowFreeAnswer: {
          type: "boolean",
          description: "Accept a typed answer as well as (or instead of) the offered choices. A question with neither a choice nor this flag is refused, because nobody could answer it and the run would wait forever.",
        },
        expiresInSeconds: {
          type: "integer",
          minimum: 1,
          maximum: 86400,
          description: "How long the question stays answerable, in seconds. Defaults to 24 hours and is capped there: an expired question releases the run as ask_user_timeout without inventing an answer.",
        },
      },
    },
    outputSchema: resultEnvelope("code.ask_user", {
      type: "object",
      required: ["questionId", "status", "choices", "allowFreeAnswer", "expiresAt"],
      additionalProperties: false,
      properties: {
        questionId: { type: "string" },
        status: { type: "string" },
        choices: { type: "integer" },
        allowFreeAnswer: { type: "boolean" },
        expiresAt: { type: "string" },
      },
    }),
  },
  /**
   * C11 (owner decision 2): the `code.git.*` workflow tools, mirroring `code-tool-schemas.json`.
   *
   * `workspaceRevision` is in every result that can change the tree: the caller compares it with the
   * revision it captured, which is what makes a git operation and a sandbox build provably run against
   * the same canonical revision.
   */
};
