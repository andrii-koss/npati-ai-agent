import { brandConfig } from "@npati/branding";
import { describe, expect, it } from "vitest";

describe("branding boundary", () => {
  it("loads the centralized NPATI identity", () => {
    expect(brandConfig).toMatchObject({
      name: "NPATI Agent",
      shortName: "NPATI",
      description: "AI Business Agent",
    });
    expect(brandConfig.colors.accent).toBe("#e11d2e");
  });
});

