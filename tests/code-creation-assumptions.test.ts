import { describe, expect, it } from "vitest";
import { briefCreationAssumptions } from "../apps/agent-api/src/code-creation-assumptions";

describe("D07 short creation requests disclose their assumptions", () => {
  it("discloses the working scope and example business data in the user's language", () => {
    const notice = briefCreationAssumptions("зроби мені сайт для кав'ярні", "uk");
    expect(notice).toContain("Припущення");
    expect(notice).toContain("базовий робочий сайт");
    expect(notice).toContain("яких ви не надали");
    expect(briefCreationAssumptions("Build a cafe website", "en")).toContain("Assumptions");
  });
  it("does not replace a detailed brief with generic assumptions", () => {
    expect(briefCreationAssumptions("Build a cafe website\nMenu and hours are attached", "en")).toBeNull();
    expect(briefCreationAssumptions("x".repeat(121), "en")).toBeNull();
    expect(briefCreationAssumptions(" ", "uk")).toBeNull();
  });
});
