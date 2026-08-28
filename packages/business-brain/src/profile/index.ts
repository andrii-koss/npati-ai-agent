import type { BusinessProfile } from "@npati/shared";

export function createIdeaProfile(id: string): BusinessProfile {
  return { id, stage: "idea" };
}

