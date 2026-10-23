import { describe, expect, it } from "vitest";
import { publicCompanyRunMessage } from "../apps/agent-api/src/chat-public-errors";

describe("public company run message", () => {
  it("names a policy refusal instead of blaming the AI model", () => {
    const refused = publicCompanyRunMessage("", 'Agent "Олена" may not use storage.company_memory', "Перейменуй агента Марко", "TOOL_FORBIDDEN");
    expect(refused).toBe('Завдання компанії не виконано: Agent "Олена" may not use storage.company_memory');
    expect(publicCompanyRunMessage("", "Main agent is inactive", "Run the company", "MAIN_AGENT_INACTIVE")).toMatch(/^The company task was not completed/);
    expect(publicCompanyRunMessage("", "upstream 503", "Запусти компанію", "MODEL_UNAVAILABLE")).toMatch(/AI-моделі/);
  });
});
