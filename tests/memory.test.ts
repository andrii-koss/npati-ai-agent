import { InMemoryProvider } from "@npati/memory";
import { describe, expect, it } from "vitest";

describe("Business Memory", () => {
  it("remembers and searches business context", async () => {
    const memory = new InMemoryProvider();
    await memory.remember("product", { name: "Handmade desk" });
    await expect(memory.search("desk")).resolves.toHaveLength(1);
  });

  it("rejects secrets", async () => {
    const memory = new InMemoryProvider();
    await expect(memory.remember("preference", { apiKey: "secret" })).rejects.toThrow("Secrets");
  });
});

