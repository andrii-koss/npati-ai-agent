import { describe, expect, it } from "vitest";
import type { BrowserQaAction } from "@npati/workspace";
import { behaviourActions, behaviourMessage, captureBehaviour, compareBehaviour, requestsBehaviourKeeping, textDifference } from "../apps/agent-api/src/website-behaviour-check";

describe("behaviour-keeping requests", () => {
  it("recognises refactors and extractions in several languages", () => {
    for (const message of [
      "винеси картку товару меню в окремий компонент ProductCard без зміни поведінки і вигляду",
      "винеси перемикач категорій меню в окремий компонент CategoryFilter",
      "зроби рефакторинг форми замовлення",
      "вынеси карточку товара в отдельный компонент",
      "extract the cart into its own component",
      "refactor the header, keep the same behaviour",
    ]) expect(requestsBehaviourKeeping(message), message).toBe(true);
  });
  it("does not treat ordinary edits as behaviour-keeping", () => {
    for (const message of ["зміни колір кнопки на зелений", "додай сторінку FAQ", "make the title bigger", "виправ помилку 500"])
      expect(requestsBehaviourKeeping(message), message).toBe(false);
  });
});

describe("click plan", () => {
  it("clicks each distinct enabled labelled button once, within the 16-action bound", () => {
    const { actions, labels } = behaviourActions([
      { label: "Додати" }, { label: "Додати" }, { label: "Усі" }, { label: "" }, { label: "Видалити", disabled: true },
      { label: "Кава" }, { label: "a\"b" }, { label: "Випічка" }, { label: "+" }, { label: "−" }, { label: "Оформити" }, { label: "Зайва" },
    ]);
    expect(labels).toEqual(["Додати", "Усі", "Кава", "Випічка", "+", "−", "Оформити"]);
    expect(actions.length).toBeLessThanOrEqual(16);
    expect(actions[0]).toEqual({ type: "click", selector: ':nth-match(button:has-text("Додати"), 1)' });
  });
});

/** A fake Browser QA run: the page text after each click comes from `effect`. */
function fakeInspect(buttons: string[], effect: (label: string, cart: number) => number) {
  return async (actions: BrowserQaAction[]) => {
    let cart = 0;
    const observe = () => ({ text: `Кошик (${cart}) Разом: ${cart * 45} ₴`, buttons: buttons.map(label => ({ label, disabled: false })) });
    const interactionTrace = actions.map(action => {
      const before = observe();
      if (action.type === "click") cart = effect(/"([^"]+)"/.exec(action.selector)?.[1] ?? "", cart);
      return { action, status: "completed" as const, before, after: observe() };
    });
    return { metrics: { interactionTrace } as never };
  };
}

describe("before/after comparison", () => {
  const working = (label: string, cart: number) => label === "Додати" ? cart + 1 : label === "Очистити" ? 0 : cart;
  it("passes when every click gives the same result as before", async () => {
    const baseline = await captureBehaviour(fakeInspect(["Додати", "Очистити"], working));
    expect(baseline?.steps).toHaveLength(2);
    const outcome = await compareBehaviour(baseline!, fakeInspect(["Додати", "Очистити"], working));
    expect(outcome).toEqual({ findings: [], checked: 2 });
    expect(behaviourMessage("uk", outcome)).toContain("2 кнопок після зміни працюють так само");
  });
  it("names the button whose result changed (live V6 case: 'Додати' no longer adds)", async () => {
    const baseline = await captureBehaviour(fakeInspect(["Додати", "Очистити"], working));
    const broken = (label: string, cart: number) => label === "Додати" ? cart : working(label, cart);
    const outcome = await compareBehaviour(baseline!, fakeInspect(["Додати", "Очистити"], broken));
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]).toMatchObject({ label: "Додати" });
    expect(outcome.findings[0]!.before).toContain("Кошик (1) Разом: 45");
    expect(outcome.findings[0]!.after).toContain("Кошик (0) Разом: 0");
    expect(outcome.findings[0]!.fix).toMatch(/arguments/);
    expect(behaviourMessage("uk", outcome)).toContain("Кнопка «Додати»");
  });
  it("reports a button that disappeared", async () => {
    const baseline = await captureBehaviour(fakeInspect(["Додати"], working));
    const gone = async (actions: BrowserQaAction[]) => ({ metrics: { interactionTrace: actions.slice(0, 1).map(action => ({ action, status: "failed" as const, before: { text: "", buttons: [] }, after: { text: "", buttons: [] } })) } as never });
    const outcome = await compareBehaviour(baseline!, gone);
    expect(outcome.findings[0]!.message).toContain("Додати");
  });
});

it("shows only the differing part of two texts", () => {
  expect(textDifference("Кошик (1) Разом: 45 ₴ Меню", "Кошик (0) Разом: 0 ₴ Меню", 3)).toEqual({ before: "к (1) Разом: 45 ₴ ", after: "к (0) Разом: 0 ₴ " });
});
