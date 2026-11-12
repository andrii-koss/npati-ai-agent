import type { AuthContext, WorkspaceStore } from "@npati/workspace";

/** "Створи компанію … і заповни бізнес-профіль": the request itself creates a company, so its Business belongs to that one. */
const CREATES_COMPANY = /(?:створ\p{L}*|созда\p{L}*|create|crée|erstelle|crea|utwórz|stwórz|crie|maak)\s+(?:\p{L}+\s+){0,3}(?:компані\p{L}*|компани\p{L}*|company|entreprise|unternehmen|empresa|azienda|firm\p{L}*|bedrijf)/iu;
export function requestCreatesCompany(message: string): boolean {
  return CREATES_COMPANY.test(message);
}

/**
 * The tool-loop form of `linkTurnBusinessToCreatedCompany`: reads the turn's Business Profile outcome from the loop
 * metadata and records the linked company on it, so the reply card names the company.
 */
export async function linkTurnCompanyAndBusiness(store: WorkspaceStore, auth: AuthContext, metadata: Record<string, unknown>[],
  company: { action: string; companyId: string } | undefined): Promise<string | undefined> {
  const outcomes = metadata.filter((item) => item.kind === "business_profile" && item.outcome && typeof item.outcome === "object")
    .map((item) => item.outcome as { action: string; alreadyExisted: boolean; businessId: string; linkedCompanyId?: string; linkedCompanyName?: string });
  const created = outcomes.filter((item) => item.action === "create" && !item.alreadyExisted).at(-1);
  if (!created || !company) return undefined;
  const name = await linkTurnBusinessToCreatedCompany(store, auth, { company, business: { createdThisTurn: true, businessId: created.businessId } });
  if (name) Object.assign(created, { linkedCompanyId: company.companyId, linkedCompanyName: name });
  return name;
}

/**
 * One chat turn that created both a company and a Business Profile ("створи компанію V6TEST_Bakery і заповни
 * бізнес-профіль") links them: the company was created for that business. A company that already has a Business
 * keeps it. Returns the linked company's name, for the reply.
 */
export async function linkTurnBusinessToCreatedCompany(store: WorkspaceStore, auth: AuthContext, input: {
  company?: { action: string; companyId: string };
  business?: { createdThisTurn: boolean; businessId: string };
}): Promise<string | undefined> {
  if (input.company?.action !== "create" || !input.business?.createdThisTurn) return undefined;
  const company = await store.getCompany(auth, input.company.companyId).catch(() => undefined);
  if (!company) return undefined;
  if (company.businessId === input.business.businessId) return company.name;
  if (company.businessId) return undefined;
  const linked = await store.updateCompany(auth, company.id, { businessId: input.business.businessId }, company.revision);
  return linked.businessId === input.business.businessId ? linked.name : undefined;
}
