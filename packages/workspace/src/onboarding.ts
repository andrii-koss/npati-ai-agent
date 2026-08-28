import type { BusinessInput, OnboardingScenario } from "./types";

export interface OnboardingStep {
  field: string;
  prompt: string;
  hint: string;
}

export const ONBOARDING_FLOWS: Record<OnboardingScenario, OnboardingStep[]> = {
  existing: [
    { field: "businessSnapshot", prompt: "Tell me about your business in one message: its name, what it sells, niche, country or market, target audience, business stage, whether you work solo or with a team, B2C or B2B, online or local, and website if you have one. Example: “Happy Candle sells handmade soy candles online in the United States to people buying home décor and gifts. It is a solo B2C operating business, and the website is happycandle.com.”", hint: "Invite one comprehensive answer. The user may omit details they do not know; do not turn this into a sequence of follow-up questions." },
    { field: "businessGoal", prompt: "What is the first meaningful goal you want to achieve for this business? Give one concrete outcome. Example: “I want to get my first 1,000 customers.”", hint: "Briefly acknowledge the business context, do not show a business plan, and ask only for one initial goal with the example." },
  ],
  starting: [
    { field: "businessSnapshot", prompt: "Describe the business you want to start in one message. Include the idea, country or market, what you want to sell, who it is for, the problem it solves, online or local format, and whether you will work solo or with a team. A name is optional. Example: “I want to launch an online Ukrainian language-learning subscription in Poland for Ukrainian families, starting solo with weekly lessons and printable materials.”", hint: "Invite one comprehensive answer and explicitly say it is fine if some details are still unknown." },
    { field: "businessGoal", prompt: "What is the first meaningful goal you want to achieve? Give one concrete outcome. Example: “I want to get my first 1,000 customers.”", hint: "Briefly acknowledge the business idea, do not show a business plan, and ask only for one initial goal with the example." },
  ],
  seller: [
    { field: "businessSnapshot", prompt: "Tell me everything important about what you want to sell in one message: the product or service, price if known, target buyer, country or marketplace, whether the sale is online or local, and whether this is a one-time sale or an ongoing business. Example: “I want to sell handmade oak shelves for €80 through Instagram and local delivery in Germany, mainly to renters; I want this to become an ongoing business.”", hint: "Invite one comprehensive answer. Unknown details may be omitted." },
    { field: "businessGoal", prompt: "What is the first meaningful goal for what you want to sell? Give one concrete outcome. Example: “I want to make my first 100 sales.”", hint: "Briefly acknowledge the selling context, do not show a selling plan, and ask only for one initial goal with the example." },
  ],
};

function normalizedChoice(value: string, choices: Array<[RegExp, string]>) {
  return choices.find(([pattern]) => pattern.test(value))?.[1] ?? value.trim();
}

export function onboardingBusinessPatch(field: string, value: string): Partial<BusinessInput> {
  const clean = value.trim();
  if (field === "businessStage") return { businessStage: normalizedChoice(clean, [[/idea/i, "idea"], [/start/i, "starting"], [/operat/i, "operating"], [/grow/i, "growing"], [/scal/i, "scaling"]]) as BusinessInput["businessStage"] };
  if (field === "teamType") return { teamType: normalizedChoice(clean, [[/solo|alone|myself/i, "solo"], [/team|people|staff/i, "team"]]) as BusinessInput["teamType"] };
  if (field === "presenceType") return { presenceType: normalizedChoice(clean, [[/both/i, "both"], [/local|offline|store/i, "local"], [/online|internet/i, "online"]]) as BusinessInput["presenceType"] };
  if (field === "businessType") return { businessType: /one.?time|single|once/i.test(clean) ? "one_time_seller" : /ongoing|business|regular/i.test(clean) ? "seller" : clean };
  return { [field]: clean } as Partial<BusinessInput>;
}

export function onboardingPlaceholder(scenario: OnboardingScenario): BusinessInput & Required<Pick<BusinessInput, "businessStage">> {
  if (scenario === "starting") return { name: "New Business Idea", businessType: "startup_idea", businessStage: "idea" };
  if (scenario === "seller") return { name: "New Selling Context", businessType: "seller", businessStage: "starting" };
  return { name: "Business setup", businessType: "existing", businessStage: "operating" };
}
