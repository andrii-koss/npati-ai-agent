import type { AuthContext, Business, WorkspaceStore } from "@npati/workspace";

/**
 * A Company may be linked only to the Business Profile the request names, to its current Business, or to one the server
 * created for this request. A model guessing a similarly named Business would hand the Company another Business's
 * memory and goals (V5-D65). With a single owned Business there is nothing to confuse.
 */
export async function assertRequestedBusinessLink(store: WorkspaceStore, auth: AuthContext, linked: Business, requestMessage: string | undefined, allowedIds: Array<string | null | undefined>): Promise<void> {
  if (!requestMessage || allowedIds.includes(linked.id)) return;
  if (requestMessage.toLocaleLowerCase().includes(linked.name.trim().toLocaleLowerCase())) return;
  if ((await store.listUserBusinesses(auth)).length <= 1) return;
  throw new Error(`Business "${linked.name}" is not named in this request. Link only the Business Profile the user named; create it first if it does not exist yet.`);
}
