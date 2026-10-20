import { describe, expect, it } from "vitest";
import { visionInferenceCandidates } from "../apps/agent-api/src/chat-inference-candidates";
import type { AIModelSummary } from "@npati/omniroute-adapter";

const model = (id: string, capabilities: string[]) => ({ id, providerId: id.split("/")[0], name: id, capabilities }) as AIModelSummary;
describe("coding chat image model selection", () => {
  it("uses a known vision model instead of an unknown configured default or text-only selection", () => {
    const added = [model("local/text", ["chat", "text"]), model("connected/vision", ["chat", "text", "vision"])];
    expect(visionInferenceCandidates(["local/text", "unknown/vision"], added)).toEqual(["connected/vision"]);
  });
  it("prefers the selected vision model and removes duplicates", () => {
    const added = [model("first/vision", ["chat", "vision"]), model("selected/vision", ["chat", "vision"])];
    expect(visionInferenceCandidates(["selected/vision", "selected/vision"], added)).toEqual(["selected/vision", "first/vision"]);
  });
  it("requires advertised image support", () => {
    expect(visionInferenceCandidates(["unknown/vision"], [model("local/text", ["chat", "text"])])).toEqual([]);
  });
});
