import type { Goal } from "./types";

export const GOALS_PAGE_SIZE = 10;

export type GoalPageQuery = {
  businessId?: string;
  status?: Goal["status"];
  priority?: number;
  search?: string;
  after?: { createdAt: string; id: string };
};

export type GoalCounts = {
  total: number;
  active: number;
  paused: number;
  completed: number;
  highPriority: number;
};

export type GoalPage = {
  goals: Goal[];
  counts: GoalCounts | null;
  nextCursor: string | null;
};

export function goalPageCursor(goal: Pick<Goal, "createdAt" | "id">) {
  return Buffer.from(JSON.stringify([new Date(goal.createdAt).toISOString(), goal.id])).toString("base64url");
}

export function decodeGoalPageCursor(cursor: string): NonNullable<GoalPageQuery["after"]> {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (typeof createdAt === "string" && new Date(createdAt).toISOString() === createdAt &&
        typeof id === "string" && id.length > 0 && id.length <= 128) {
      return { createdAt, id };
    }
  } catch { /* The caller receives a validation error. */ }
  throw new Error("Invalid goals cursor");
}
