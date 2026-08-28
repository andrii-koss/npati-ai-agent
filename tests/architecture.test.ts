import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("architecture boundaries", () => {
  it("keeps domain packages independent of OmniRoute source internals", () => {
    for (const packageName of ["agent", "business-brain", "memory", "skills", "branding", "hub-connector"]) {
      const manifest = readFileSync(join(process.cwd(), "packages", packageName, "package.json"), "utf8");
      expect(manifest).not.toContain("vendor/omniroute");
    }
  });
});

