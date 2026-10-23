/**
 * Turn and time budgets that follow the size of the task (audit F-13: with both limits at 0 a looping edit ran 71
 * turns). A class budget only ever lowers the operator's limit, never raises it; `0` (unlimited) is replaced by the
 * class budget. Delegated runs and explicit `maxTurns` callers (visual repair, sub-agents) keep their own limits.
 */
export type CodeRunTaskClass = "analysis" | "small_edit" | "visual_edit" | "creation" | "general";

export const CODE_RUN_TASK_BUDGETS: Readonly<Record<CodeRunTaskClass, { turns: number; minutes: number }>> = Object.freeze({
  analysis: { turns: 12, minutes: 8 },
  small_edit: { turns: 24, minutes: 12 },
  visual_edit: { turns: 40, minutes: 20 },
  creation: { turns: 60, minutes: 30 },
  // A code project of unknown size keeps exactly the operator's limits.
  general: { turns: 0, minutes: 0 },
});

export function classifyRunTask(input: {
  readOnlyIntent?: boolean;
  sessionMode?: string;
  websiteEdit?: boolean;
  requireImplementation?: boolean;
  imageCount?: number;
}): CodeRunTaskClass {
  if (input.readOnlyIntent || input.sessionMode === "plan") return "analysis";
  if (input.requireImplementation) return "creation";
  if (input.websiteEdit && (input.imageCount ?? 0) > 0) return "visual_edit";
  if (input.websiteEdit) return "small_edit";
  return "general";
}

/** The effective limit: the smaller of the configured limit and the class budget; `0` means "not configured". */
export function adaptiveLimit(configured: number, classBudget: number, enabled: boolean): number {
  const limit = Math.max(0, Math.trunc(configured));
  if (!enabled || classBudget <= 0) return limit;
  return limit > 0 ? Math.min(limit, classBudget) : classBudget;
}
