import type { BusinessGoal } from "../types";

export function createGoal(id: string, title: string): BusinessGoal {
  return { id, title, status: "planned" };
}

