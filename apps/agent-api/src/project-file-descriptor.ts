import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

/** Linux read opens every parent relative to an already-open directory.
 * /proc/self/fd is used only for our own live descriptors, never caller input.
 * O_DIRECTORY|O_NOFOLLOW refuses replacement symlinks at every component.
 * This is a read primitive, not a claim of CAS rename/delete or Git isolation.
 */
export async function openWorkspaceRead(absolute: string) {
  if (process.platform !== "linux") return open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  if (!path.isAbsolute(absolute)) throw Object.assign(new Error("Absolute workspace path required"), { code: "EINVAL" });
  const parts = absolute.split("/").filter(Boolean);
  if (!parts.length || parts.some(part => part === "." || part === "..")) throw Object.assign(new Error("Invalid workspace path"), { code: "EINVAL" });
  let parent = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of parts.slice(0, -1)) {
      const next = await open("/proc/self/fd/" + parent.fd + "/" + component, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await parent.close(); parent = next;
    }
    return await open("/proc/self/fd/" + parent.fd + "/" + parts[parts.length - 1], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } finally { await parent.close(); }
}
