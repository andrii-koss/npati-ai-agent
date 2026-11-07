import { describe, expect, it } from "vitest";
import { evaluateScopeGuard } from "../apps/agent-api/src/code-scope-guard";

const check = (requestText: string, changedPaths: string[]) => evaluateScopeGuard({ requestText, changedPaths, maxChangedFiles: 20 });

describe("scope focus from the request text", () => {
  it("does not take a list of technologies for a folder", () => {
    for (const request of ["Створи лендинг на чистих HTML/CSS/JS з контактною формою", "Зроби сайт UA/EN", "Створи компонент на React/Vue"]) {
      expect(check(request, ["index.html", "styles.css", "script.js"]).unrelatedPaths, request).toEqual([]);
    }
  });
  it("still keeps a real folder named in the request as the focus", () => {
    expect(check("Виправ кнопку в src/components/Button.tsx", ["src/components/Button.tsx", "server/db.js"]).unrelatedPaths).toEqual(["server/db.js"]);
  });
});
