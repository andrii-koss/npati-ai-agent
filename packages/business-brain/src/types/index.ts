export interface BusinessGoal {
  id: string;
  title: string;
  status: "planned" | "active" | "complete";
}

export interface BusinessRecommendation {
  title: string;
  reason: string;
  nextAction: string;
}

