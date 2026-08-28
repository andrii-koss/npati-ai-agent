import type { BusinessRecommendation } from "../types";

export function recommendFirstValidation(): BusinessRecommendation {
  return {
    title: "Validate demand before expanding",
    reason: "A small customer test reduces uncertainty before larger investments.",
    nextAction: "Interview three potential customers about the problem you want to solve.",
  };
}

