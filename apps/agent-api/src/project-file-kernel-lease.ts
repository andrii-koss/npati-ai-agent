import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

export interface KernelFileLease { release(): Promise<void> }
/** Linux extension of the existing Workspace lease, not a second transaction.
 * The safe, NOFOLLOW-opened description is shared with a constant flock helper.
 * Parent death closes stdin; helper exit closes its descriptors. A paused owner
 * retains the kernel lock, so heartbeat expiry cannot admit another writer.
 */
export async function acquireKernelFileLease(base: string, error: (code: string, message: string) => Error): Promise<KernelFileLease | undefined> {
  if (process.platform !== "linux") return undefined;
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path.join(base, ".npati-write-fence"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
  catch { throw error("workspace_lock_unavailable", "Workspace fence could not be safely opened"); }
  let entry: Awaited<ReturnType<typeof handle.stat>>;
  try { entry = await handle.stat(); }
  catch { await handle.close(); throw error("workspace_lock_unavailable", "Workspace fence could not be inspected"); }
  if (!entry.isFile() || entry.nlink !== 1) { await handle.close(); throw error("invalid_path", "Unsafe workspace fence"); }
  // All command text is constant; no project code, shell arguments or paths are interpolated.
  const child = spawn("/bin/sh", ["-c", "command -v flock >/dev/null 2>&1 || exit 69; if flock -w 0 /dev/null true >/dev/null 2>&1; then flock -x -w 10 3; else flock -x 3; fi || exit 75; printf 'NPATI_LEASE_READY\\n'; cat >/dev/null"],
    { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["pipe", "pipe", "ignore", handle.fd] });
  const leaseInput = child.stdin, leaseOutput = child.stdout;
  if (!leaseInput || !leaseOutput) { child.kill("SIGKILL"); await handle.close(); throw error("workspace_lock_unavailable", "Workspace kernel lease pipes are unavailable"); }
  leaseInput.on("error", () => { /* A terminated holder may already have closed stdin. */ });
  let closed = false, released = false;
  const done = new Promise<void>(resolve => { child.once("close", () => { closed = true; resolve(); }); child.once("error", resolve); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(error("workspace_busy", "Workspace kernel lease timed out")), 12000);
      const finish = (failure?: Error) => { clearTimeout(timer); failure ? reject(failure) : resolve(); };
      child.once("error", () => finish(error("workspace_lock_unavailable", "Workspace kernel lease helper is unavailable")));
      child.once("close", code => finish(error(code === 69 ? "workspace_lock_unavailable" : "workspace_busy", code === 69 ? "Workspace kernel lease requires flock" : "Workspace kernel lease could not be acquired")));
      leaseOutput.on("data", chunk => {
        output = (output + chunk.toString()).slice(-128);
        if (output.includes("NPATI_LEASE_READY\n")) finish();
      });
    });
  } catch (failure) {
    leaseInput.end(); if (!closed) child.kill("SIGKILL");
    await done; await handle.close(); throw failure;
  }
  return {
    async release() {
      if (released) return; released = true;
      leaseInput.end();
      const timer = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 2000);
      try { await done; } finally { clearTimeout(timer); await handle.close(); }
    },
  };
}
