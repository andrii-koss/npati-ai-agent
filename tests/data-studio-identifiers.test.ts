import { describe, expect, it } from "vitest";
import { quoteIdentifier, validateIdentifier, bindFilter } from "../apps/agent-api/src/data-studio/identifier";

describe("Data Studio SQL boundaries", () => {
  it("rejects unsafe and reserved identifiers", () => {
    for (const value of ["a; DROP TABLE x", 'a"b', "é", "a".repeat(64), "select", "_npati_migrations", "pg_class", "1bad"]) {
      expect(() => validateIdentifier(value)).toThrow();
    }
    expect(quoteIdentifier("orders")).toBe('"orders"');
  });

  it("binds filter values, including injection text, as parameters", () => {
    const values: unknown[] = [];
    const clause = bindFilter("title", "eq", "x' OR true --", values);
    expect(clause).toBe('"title" = $1');
    expect(values).toEqual(["x' OR true --"]);
  });
});
