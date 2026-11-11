import { describe, expect, it } from "vitest";
import { projectDeleteTarget } from "../apps/agent-api/src/chat-project-delete";

const projects = ["Пекарня", "Тимчасовий сайт перевірки", "Сайт", "Сайт", "Блог про каву"].map((name, index) => ({ id: "p" + index, name }));

describe("which site a delete request names", () => {
  it("takes the specific name, not the generic kind word that also appears in the request", () => {
    expect(projectDeleteTarget(projects, "видали сайт Тимчасовий сайт перевірки")?.id).toBe("p1");
    expect(projectDeleteTarget(projects, "Видали блог Блог про каву")?.id).toBe("p4");
  });

  it("still finds a site literally called «Сайт» when it is quoted and unique", () => {
    const one = [{ id: "a", name: "Сайт" }, { id: "b", name: "Пекарня" }];
    expect(projectDeleteTarget(one, "видали «Сайт»")?.id).toBe("a");
  });

  it("does not pick between two specific sites, and does not pick one of two sites called «Сайт»", () => {
    expect(projectDeleteTarget(projects, "видали сайти Пекарня і Блог про каву")).toBeUndefined();
    expect(projectDeleteTarget(projects, "видали сайт")).toBeUndefined();
  });
});
