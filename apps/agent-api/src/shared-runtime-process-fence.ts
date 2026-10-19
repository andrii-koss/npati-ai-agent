import { readFile, readdir } from "node:fs/promises";
import { SandboxProviderError } from "./sandbox-provider";

/** Read-only restart barrier. A saved PID or the death of the JS supervisor is
 * not evidence of tree termination. Never signal a PID/UID discovered here.
 * This is an observation guard, not a kernel quiescence proof against a hostile
 * legacy fork race. New descendants are separately bound to the PID namespace.
 */
export async function assertProjectQuiescent(uid: number): Promise<void> {
  if (!Number.isSafeInteger(uid) || uid < 10000 || uid > 60000) throw new SandboxProviderError("runtime_state_invalid", "Invalid project process identity", 503);
  for (const pid of await readdir("/proc")) {
    if (!/^[0-9]+$/.test(pid)) continue;
    try {
      const status = await readFile("/proc/" + pid + "/status", "utf8");
      const ids = /^Uid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
      const state = /^State:\s+(\S)/m.exec(status)?.[1];
      if (ids?.includes(uid) && state !== "Z" && state !== "X") throw new SandboxProviderError("runtime_recovery_required", "Previous project processes remain; admission is closed until their isolation or termination is confirmed", 503);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

export function awaitProcessClose(child: import("node:child_process").ChildProcess, closed: WeakSet<import("node:child_process").ChildProcess>): Promise<void> {
  if (closed.has(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.removeListener("close", finish); reject(new SandboxProviderError("process_termination_unconfirmed", "Process tree termination is not confirmed", 503)); }, 5000);
    child.once("close", finish);
  });
}
