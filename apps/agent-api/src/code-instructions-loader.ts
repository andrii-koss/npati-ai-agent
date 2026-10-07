import type { AuthContext } from "@npati/workspace";
import {
  INSTRUCTION_FILE_NAMES,
  buildProjectInstructions,
  projectInstructionsContentHash,
  type ProjectInstructions,
  type ProjectInstructionFile,
} from "./code-project-instructions";
import { buildInstructionsDraft, type InstructionsDraft } from "./code-instructions-init";
import { CODE_COMMANDS_DIRECTORY, CODE_COMMAND_FILE_EXTENSION } from "./code-commands";

/** C13: the ids a repository may use to declare its slash-command directory explicitly. */
const COMMAND_MANIFEST_NAMES = ["commands.json", "index.json"] as const;
/** C13: the one extension a command may use. `.json` is the declared form, `.md` the authored one. */
const CODE_COMMAND_EXTENSIONS = [CODE_COMMAND_FILE_EXTENSION, ".json"] as const;

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

  /**
   * C13 — the repository's slash-command files, read through **this** loader.
   *
   * Why here and not in a new module: this file is the only place that reads workspace text for instructions,
   * and `readWorkspaceText` underneath it is the only path-guarded read. Adding a second reader would mean a
   * second path guard, a second trust call and a second place to forget the trust gate. The command files are
   * therefore collected by the same function, with the same trust answer, and the same non-recursive,
   * bounded probe discipline.
   *
   * **Trust is asked before the first read, not after.** When the project is not trusted the function returns
   * immediately: `readsAttempted` stays `0` and `readFile` is never called, which is the property the C13 suite
   * proves with a spy. The caller (`code-command-registry.ts`) therefore receives "untrusted" without ever
   * having been handed repository bytes.
   *
   * **Discovery is bounded by name, never by a directory walk.** A repository cannot make the loader list a
   * directory, so there is no unbounded enumeration: two files per declared name (`<id>.md`, `<id>.json`), plus
   * the explicitly declared manifest names (`.npati/commands/commands.json` and `index.json`) whose ids are
   * resolved by the registry. The probe names are supplied by the caller, which derives them from the command
   * ids the *platform* already knows — a file the run never asks about is never read.
   */
  async function collectCommands(input: {
    ctx: AuthContext;
    companyId: string;
    projectId: string;
    targetPaths?: readonly string[];
    /** Command ids to probe for. Bounded by the caller; the loader never invents a name. */
    ids?: readonly string[];
  }): Promise<{ files: ProjectInstructionFile[]; readsAttempted: number; trusted: boolean }> {
    let trusted = false;
    try {
      trusted = (await deps.isTrusted({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId })) === true;
    } catch {
      trusted = false;
    }
    // The gate: an untrusted repository's command directory is not read — not even probed for existence.
    if (!trusted) return { files: [], readsAttempted: 0, trusted: false };

    const files: ProjectInstructionFile[] = [];
    let readsAttempted = 0;
    const read = async (path: string): Promise<void> => {
      readsAttempted += 1;
      try {
        const content = await deps.readFile({ ctx: input.ctx, companyId: input.companyId, projectId: input.projectId, path });
        if (typeof content === "string") files.push({ path, content });
      } catch {
        // Absent or unreadable: not a command of this run.
      }
    };

    for (const name of COMMAND_MANIFEST_NAMES) {
      await read(`${CODE_COMMANDS_DIRECTORY}/${name}`);
    }
    for (const name of input.ids ?? []) {
      const id = String(name ?? "").trim().toLowerCase();
      if (!/^[a-z][a-z0-9:_-]{0,63}$/.test(id)) continue;
      for (const extension of CODE_COMMAND_EXTENSIONS) {
        await read(`${CODE_COMMANDS_DIRECTORY}/${id}${extension}`);
      }
    }
    return { files, readsAttempted, trusted: true };
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
    collectCommands,
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
