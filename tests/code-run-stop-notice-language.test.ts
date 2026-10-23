import { describe, expect, it } from "vitest";
import { localizeRunStopNotice, publicCodeChatReply } from "../apps/agent-api/src/project-chat-cards";

describe("Coding Agent stop notice in the chat language", () => {
  it("renders the run's stop notices in the conversation language and keeps the technical detail", async () => {
    expect(localizeRunStopNotice("Stopped after 12 minutes: the time limit was reached.", "uk")).toBe("Зупинено через 12 хв: досягнуто ліміту часу.");
    expect(localizeRunStopNotice("Stopped: the same error (code.fs.edit:edit_no_match) kept repeating.", "uk")).toContain("(code.fs.edit:edit_no_match)");
    expect(localizeRunStopNotice("Stopped: the self-review could not be completed (review_parser_unavailable), so the change was not reviewed.", "pt")).toMatch(/^Interrompido/);
    expect(localizeRunStopNotice("Stopped after 3 minutes: the time limit was reached.", "en")).toBe("Stopped after 3 minutes: the time limit was reached.");
    const card = { id: "p", projectId: "p", companyId: "c", name: "Site", kind: "website_project" } as never;
    expect(await publicCodeChatReply({} as never, {} as never, card, "Stopped after 12 minutes: the time limit was reached.", "de")).toMatch(/^Nach 12 Min\. gestoppt/);
    expect(await publicCodeChatReply({} as never, {} as never, card, "Changed the button colour.", "uk")).toBe("Changed the button colour.");
  });
});
