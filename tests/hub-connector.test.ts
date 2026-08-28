import { createHubClient } from "@npati/hub-connector";
import { describe, expect, it } from "vitest";

describe("Hub Connector", () => {
  it("keeps an optional local Hub from breaking startup", async () => {
    await expect(createHubClient().healthCheck()).resolves.toMatchObject({ status: "not_configured" });
  });
});

