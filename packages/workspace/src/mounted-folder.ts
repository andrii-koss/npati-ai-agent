/**
 * C15: the comparison key for a **mounted local folder** path.
 *
 * The allowlist stores the canonical path twice: `path` keeps the spelling the owner confirmed (what the
 * audit trail and the operator read) and `path_key` is what any lookup compares. Two facts make that
 * necessary rather than decorative:
 *
 *  - on Windows a path is case-insensitive, and a confirmation of `D:\Work\Repo` must be found by a request
 *    naming `d:\work\repo` — a case mismatch would otherwise read as "this project has no mount", which is a
 *    silent behaviour change rather than a refusal;
 *  - a trailing separator is the same directory, and comparing the two spellings literally would make
 *    `D:\Work\Repo\` a different workspace from `D:\Work\Repo`.
 *
 * It is exported so the API boundary and the sandbox runner compare paths with **one** definition instead of
 * two that can drift: the runner re-checks the path the API sent against the row it reads itself, and a
 * disagreement about what "the same path" means would turn that re-check into a formality.
 */
export function mountedFolderPathKey(value: string): string {
  const normalized = String(value ?? "").replace(/\\/g, "/").replace(/(?!^)\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
