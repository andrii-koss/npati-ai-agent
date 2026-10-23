import { describe, expect, it } from "vitest";
import { explicitlyRequestsWebResearch } from "../apps/agent-api/src/chat-text-directives";

describe("explicit web research requests in several languages", () => {
  it("recognizes research verbs and requests for sources", () => {
    for (const message of [
      "Pesquisa os preços médios da mensalidade de estúdios de fitness boutique em Lisboa, com fontes.",
      "Recherchiere zwei echte deutsche Bäckerei-Websites und nenne drei Designideen",
      "Recherche les prix moyens des boulangeries à Lyon",
      "Busca en internet los precios de gimnasios en Madrid",
      "Порівняй ціни на хліб з джерелами",
    ]) expect(explicitlyRequestsWebResearch(message), message).toBe(true);
    expect(explicitlyRequestsWebResearch("Використай попередній аналіз цін і запропонуй ціну. Не шукай заново.")).toBe(false);
  });
});
