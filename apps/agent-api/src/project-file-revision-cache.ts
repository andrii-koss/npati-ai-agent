const MAX_ENTRIES = 200_000;

/**
 * Keeps file listings from hashing every file on every call. ctime changes on every write and cannot be set back,
 * so an unchanged key means unchanged bytes.
 */
export class FileRevisionCache {
  private readonly revisions = new Map<string, string>();

  async get(full: string, info: { ino: number; size: number; mtimeMs: number; ctimeMs: number }, compute: () => Promise<string>): Promise<string> {
    const key = `${full}|${info.ino}|${info.size}|${info.mtimeMs}|${info.ctimeMs}`;
    const known = this.revisions.get(key);
    if (known) return known;
    const value = await compute();
    if (this.revisions.size >= MAX_ENTRIES) this.revisions.clear();
    this.revisions.set(key, value);
    return value;
  }
}
