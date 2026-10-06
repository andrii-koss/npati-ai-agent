import type { AuthContext } from "@npati/workspace";
import {
  INSTRUCTION_FILE_NAMES,
  buildProjectInstructions,
  projectInstructionsContentHash,
  type ProjectInstructions,
  type ProjectInstructionFile,
} from "./code-project-instructions";
import { buildInstructionsDraft, type InstructionsDraft } from "./code-instructions-init";

/**
 * C8 — the I/O shell around the pure instructions core.
 *
 * The core (`code-project-instructions.ts`) decides *what* the instructions mean; this module decides *which
 * files to read*, and it is deliberately the only place that touches the workspace for instructions. Two
 * properties are load-bearing:
 *
 * 1. **Trust is asked, not assumed.** Every load consults the project trust service and treats a missing record,
 *    a revoked record or a thrown error as *untrusted*. There is no cache: a trust decision that outlived a
 *    content change would let "trusted" describe a file nobody reviewed.
 * 2. **Reads are bounded and non-recursive.** Only the recognised names at the root, plus the same names in the
 *    directories on the way to the work, are attempted. A directory listing is never walked recursively — an
 *    instruction file the run does not touch must not be able to inject itself.
 *
 * A read failure for one file is not an error: it means "no such instruction file", which is the common case.
 */

export interface CodeInstructionsLoaderDeps {
  readFile(input: { ctx: AuthContext; companyId: string; projectId: string; path: string }): Promise<string | null>;
  isTrusted(input: { ctx: AuthContext; companyId: string; projectId: string }): Promise<boolean>;
  /** User-level instructions (outermost scope). Absent means the user has none. */
  userInstructions?(input: { ctx: AuthContext; companyId: string }): Promise<string | null>;
  /** Facts for the `init` draft. Injected so the loader holds no detection logic of its own. */
  draftFacts?(input: { ctx: AuthContext; companyId: string; projectId: string }): Promise<{
    projectName: string;
    toolchain?: InstructionsDraftFacts["toolchain"];
    topLevelPaths?: readonly string[];
    notes?: readonly string[];
  } | null>;
}

export interface InstructionsDraftFacts {
  toolchain?: {
    languages?: readonly string[];
    packageManagers?: readonly string[];
    verifyCommands?: { install?: string; build?: string; test?: string; lint?: string; typecheck?: string };
  } | null;
}

/** Directories to probe, derived from the work's target paths: the root plus every ancestor directory. */
function probeDirectories(targetPaths: readonly string[] | undefined): string[] {
  const directories = new Set<string>([""]);
  for (const target of targetPaths ?? []) {
    const normalized = String(target ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
    const parts = normalized.split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  // Shallow scopes first, so the applied order matches the core's ordering.
  return Array.from(directories).sort((a, b) => a.split("/").filter(Boolean).length - b.split("/").filter(Boolean).length || a.localeCompare(b));
}

export function createCodeInstructionsLoader(deps: CodeInstructionsLoaderDeps) {
  async function collectFiles(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    targetPaths?: readonly string[];
  }): Promise<ProjectInstructionFile[]> {
    const files: ProjectInstructionFile[] = [];
    for (const directory of probeDirectories(input.targetPaths)) {
      for (const name of INSTRUCTION_FILE_NAMES) {
        const path = directory ? `${directory}/${name}` : name;
        try {
          const content = await deps.readFile({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, path });
          if (typeof content === "string") files.push({ path, content });
        } catch {
          // Absent or unreadable: not an instruction file for this run.
        }
      }
    }
    return files;
  }

  async function load(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    targetPaths?: readonly string[];
  }): Promise<ProjectInstructions> {
    let trusted = false;
    try {
      trusted = (await deps.isTrusted({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId })) === true;
    } catch {
      trusted = false;
    }
    let userInstructions: string | null = null;
    if (deps.userInstructions) {
      try {
        userInstructions = await deps.userInstructions({ ctx: input.ctx, companyId: input.companyId });
      } catch {
        userInstructions = null;
      }
    }
    const files = await collectFiles(input);
    return buildProjectInstructions({
      userInstructions,
      files,
      ...(input.targetPaths === undefined ? {} : { targetPaths: input.targetPaths }),
      trusted,
    });
  }

  async function buildDraft(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
  }): Promise<InstructionsDraft> {
    const facts = deps.draftFacts
      ? await deps.draftFacts({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId })
      : null;
    return buildInstructionsDraft({
      projectName: facts?.projectName ?? input.projectId,
      ...(facts?.toolchain === undefined ? {} : { toolchain: facts.toolchain }),
      ...(facts?.topLevelPaths === undefined ? {} : { topLevelPaths: facts.topLevelPaths }),
      ...(facts?.notes === undefined ? {} : { notes: facts.notes }),
    });
  }

  return {
    load,
    buildDraft,
    /** The loader's answer in the shape the runner port expects. */
    async loadForRun(input: { ctx: AuthContext; companyId: string; projectId: string; targetPaths?: readonly string[] }) {
      const instructions = await load(input);
      return {
        body: instructions.body,
        contentHash: projectInstructionsContentHash(instructions),
        trusted: instructions.trusted,
      };
    },
  };
}
