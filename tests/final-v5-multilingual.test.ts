import { describe, expect, it } from "vitest";
import { InMemoryWorkspaceStore, type AuthContext } from "@npati/workspace";
import { CompanyChatActions } from "../apps/agent-api/src/company-chat-actions";
import { namedCompanyNotFoundCopy } from "../apps/agent-api/src/company-delete-i18n";
import { CompanyAutomationsRepository } from "../apps/agent-api/src/automations-repository";
import { ContentLibraryStore } from "../apps/agent-api/src/content-library-store";
import { WorkspaceChatActions } from "../apps/agent-api/src/workspace-chat-actions";

const auth: AuthContext = { userId: "fv5-13", workspaceId: "fv5-13", permissions: ["workspace:read", "business:manage"] };
const directive = (value: object) => "```company-action\n" + JSON.stringify(value) + "\n```";

describe("Final V5 stage 13: deleting a company that does not exist", () => {
  const requests: Array<[keyof typeof namedCompanyNotFoundCopy, string]> = [
    ["en", "Delete the company «Ghost Co»."], ["uk", "Видали компанію «Ghost Co»."], ["ru", "Удали компанию «Ghost Co»."],
    ["de", "Lösche das Unternehmen «Ghost Co»."], ["es", "Elimina la empresa «Ghost Co»."],
  ];
  it.each(requests)("V5-D74 %s: says the named company was not found instead of listing or selecting another one", async (language, message) => {
    const store = new InMemoryWorkspaceStore();
    const selected = await store.createCompany(auth, { name: "Selected Bakery" }, "selected");
    await store.createCompany(auth, { name: "Other Shop" }, "other");
    const reply = await CompanyChatActions.deleteConfirmationMessage(auth, store, message, selected.id, language);
    expect(reply).toBe(namedCompanyNotFoundCopy[language].replace("{name}", "Ghost Co"));
    expect(reply).not.toContain("Selected Bakery");
    expect(reply).not.toContain("Other Shop");
    expect((await store.listCompanies(auth)).items).toHaveLength(2);
  });

  // Other languages reach the native-tool executor, which used an English fallback for 10 of the 16 languages.
  it.each(Object.keys(namedCompanyNotFoundCopy) as Array<keyof typeof namedCompanyNotFoundCopy>)("V5-D74 executor %s: refuses an unknown company in the request language", async (language) => {
    const store = new InMemoryWorkspaceStore();
    const result = await CompanyChatActions.extractAndExecute(auth, directive({ action: "delete", companyName: "Ghost Co" }), store, "d74-" + language, { requestMessage: "«Ghost Co»", responseLanguage: language });
    expect(result.companyAction).toBeUndefined();
    expect(result.cleanText).toBe(namedCompanyNotFoundCopy[language].replace("{name}", "Ghost Co"));
  });
});

describe("Final V5 stage 13: automation cards", () => {
  it("V5-D73: the card of a created automation states its next run in the automation's timezone", async () => {
    const store = new InMemoryWorkspaceStore();
    const company = await store.createCompany(auth, { name: "Clock Shop" }, "clock");
    const deps = { store, automations: new CompanyAutomationsRepository(), content: new ContentLibraryStore(store) } as never;
    const text = "```workspace-action\n" + JSON.stringify({ action: "automation.create", companyId: company.id, intro: "Створено.", automation: { name: "Weekly", prompt: "Звіт", cronExpression: "0 9 * * 1", timezone: "Europe/Kyiv", status: "active" } }) + "\n```";
    const created = await WorkspaceChatActions.extractAndExecute(auth, text, deps, "d73", { requestMessage: "Створи автоматизацію на паузі щопонеділка о 9:00" });
    expect(created.cleanText).toMatch(/\d{4}-\d{2}-\d{2} 09:00 Europe\/Kyiv/);
    expect(created.cleanText).not.toMatch(/GMT\+0000|Coordinated Universal Time/);
  });
});

describe("Final V5 stage 13: the named Business is the written Business", () => {
  it("V5-D76: a goal or profile change aimed at another Business than the one named is refused with the right ID", async () => {
    const { assertNamedBusinessTarget } = await import("../apps/agent-api/src/named-business-target");
    const store = new InMemoryWorkspaceStore();
    const named = await store.createBusiness(auth, { name: "R13PT Biz" });
    const other = await store.createBusiness(auth, { name: "R13AR Biz" });
    const request = "Adicione ao negócio «R13PT Biz» a meta «Clientes».";
    await expect(assertNamedBusinessTarget(store, auth, request, other.id)).rejects.toThrow(named.id);
    await expect(assertNamedBusinessTarget(store, auth, request, named.id)).resolves.toBeUndefined();
    // Unnamed or ambiguous requests are left to the executor.
    await expect(assertNamedBusinessTarget(store, auth, "Add a goal to our business", other.id)).resolves.toBeUndefined();
    await expect(assertNamedBusinessTarget(store, auth, "Copy «R13PT Biz» goals to «R13AR Biz»", other.id)).resolves.toBeUndefined();
    // A shorter name inside a longer one is not a second Business.
    const longer = await store.createBusiness(auth, { name: "R13PT Biz Pro" });
    await expect(assertNamedBusinessTarget(store, auth, "Add a goal to «R13PT Biz Pro»", named.id)).rejects.toThrow(longer.id);
  });
});

describe("Final V5 stage 13: conversation language across scripts", () => {
  it("V5-D77: a short message in another script switches the conversation language", async () => {
    const { resolveConversationLanguage } = await import("../apps/agent-api/src/company-chat-i18n");
    const arabic = [{ role: "user", content: "أضف إلى الشركة وكيلًا «Helper» متخصصًا في الدعم." }];
    expect(resolveConversationLanguage("Cambia su rol a «Lead».", arabic)).not.toBe("ar");
    expect(resolveConversationLanguage("Поменяй ему роль на «Lead».", arabic)).toBe("ru");
    expect(resolveConversationLanguage("把它的角色改成「Lead」。", [{ role: "user", content: "Add an agent «Helper» to the company." }])).toBe("zh");
    // Short replies in the same script still keep the active language.
    expect(resolveConversationLanguage("ok", [{ role: "user", content: "Створи компанію «Хліб» з головним агентом." }])).toBe("uk");
    expect(resolveConversationLanguage("Так", [{ role: "user", content: "Створи компанію «Хліб» з головним агентом." }])).toBe("uk");
  });
});
