import type { SandboxFile } from "./sandbox-provider";

const SYNC_STATE_TTL_MS = 300_000;
const SYNC_STATE_MAX_BYTES = 128_000_000;

interface SyncState {
  at: number;
  manifest: string;
  files: Map<string, SandboxFile>;
  bytes: number;
}

/**
 * What each sandbox was last given, so an unchanged project is not read and re-sent before every command.
 * An entry expires: a full upload then still puts back anything a background process changed in the sandbox.
 */
export class SandboxSyncStates {
  private readonly states = new Map<string, SyncState>();

  fresh(sandboxId: string): SyncState | undefined {
    const state = this.states.get(sandboxId);
    return state && Date.now() - state.at < SYNC_STATE_TTL_MS ? state : undefined;
  }

  remember(sandboxId: string, manifest: string, files: Map<string, SandboxFile>): void {
    let bytes = 0;
    for (const file of files.values()) bytes += file.content.length;
    this.states.delete(sandboxId);
    this.states.set(sandboxId, { at: Date.now(), manifest, files, bytes });
    let held = 0;
    for (const state of this.states.values()) held += state.bytes;
    for (const [id, state] of this.states) {
      if (held <= SYNC_STATE_MAX_BYTES || id === sandboxId) break;
      this.states.delete(id);
      held -= state.bytes;
    }
  }

  forget(sandboxId: string): void {
    this.states.delete(sandboxId);
  }
}

const RUNTIME_NOISE = /^(?:sent tapfd=\d+ for tap\d+|received tapfd=\d+)\r?\n?/gm;

/** The sandbox network helper prints these on every command; the model should not have to read them. */
export const withoutRuntimeNoise = <T extends { stdout: string; stderr: string }>(result: T): T => ({
  ...result,
  stdout: result.stdout.replace(RUNTIME_NOISE, ""),
  stderr: result.stderr.replace(RUNTIME_NOISE, ""),
});
