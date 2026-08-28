export interface PlanStep {
  title: string;
  complete: boolean;
}

export function createStartupPlan(): PlanStep[] {
  return [
    { title: "Define the customer and problem", complete: false },
    { title: "Describe the first offer", complete: false },
    { title: "Choose one validation channel", complete: false },
  ];
}

