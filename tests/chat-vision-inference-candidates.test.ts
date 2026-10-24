import { describe, expect, it } from "vitest";
import { visionInferenceCandidates, confirmedVisionInferenceCandidates } from "../apps/agent-api/src/chat-inference-candidates";
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


it("rejects a stale stored vision flag when the live provider catalog says text only", async () => {
  const added = [model("deepseek/deepseek-flash", ["chat", "text", "vision"])];
  const calls: string[] = [];
  expect(await confirmedVisionInferenceCandidates([added[0]!.id], added, async provider => { calls.push(provider); return [model(added[0]!.id, ["chat", "text"])]; })).toEqual([]);
  expect(calls).toEqual(["deepseek"]);
});
it("fails closed on unavailable metadata and keeps a confirmed selected image model", async () => {
  const added = [model("connected/vision", ["chat", "vision"])];
  expect(await confirmedVisionInferenceCandidates([added[0]!.id], added, async () => { throw Error("offline"); })).toEqual([]);
  expect(await confirmedVisionInferenceCandidates([added[0]!.id], added, async () => added)).toEqual([added[0]!.id]);
  expect(await confirmedVisionInferenceCandidates([added[0]!.id], added)).toEqual([]);
});
