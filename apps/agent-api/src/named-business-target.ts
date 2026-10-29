import type { AuthContext, WorkspaceStore } from "@npati/workspace";

/**
 * A goal or Business Profile change must reach the Business the request names. A model copying the ID of a similarly
 * named Business from its context would otherwise write into another Business (V5-D76). Only an unambiguous request
 * (exactly one owned Business named) is checked; a request that names none or several is left to the executor.
 */
export async function assertNamedBusinessTarget(store: WorkspaceStore, auth: AuthContext, requestMessage: string | undefined, businessId: unknown): Promise<void> {
  if (!requestMessage || typeof businessId !== "string" || !businessId) return;
  const request = requestMessage.toLocaleLowerCase();
  const named = (await store.listUserBusinesses(auth)).filter((business) => business.name.trim().length > 2 && request.includes(business.name.trim().toLocaleLowerCase()));
  // "Bakery" inside "Bakery Pro" is the longer name, not a second Business.
  const distinct = named.filter((business) => !named.some((other) => other !== business && other.name.toLocaleLowerCase().includes(business.name.toLocaleLowerCase())));
  if (distinct.length !== 1 || distinct[0]!.id === businessId) return;
  throw new Error(`This request names the Business "${distinct[0]!.name}" (ID ${distinct[0]!.id}), not ${businessId}. Use that businessId.`);
}
