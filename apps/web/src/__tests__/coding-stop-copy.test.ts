import { expect, it } from "vitest";
import { codingStopCopy } from "../coding-stop-copy";
it("explains quota stops without implying success or changing non-runtime messages",()=>{
  const raw="Stopped: A2A_TOKEN_QUOTA_EXCEEDED: Session budget exhausted (462091/500000 tokens).";
  expect(codingStopCopy(raw,"uk")).toContain("завдання ще не завершене");
  for(const language of ["en","uk","de","fr","es","it","pl"]){
    expect(codingStopCopy(raw,language)).not.toContain("A2A_");
    expect(codingStopCopy("budget_exhausted",language)).toBe(codingStopCopy(raw,language));
  }
  expect(codingStopCopy("Explain A2A_TOKEN_QUOTA_EXCEEDED", "uk")).toBe("Explain A2A_TOKEN_QUOTA_EXCEEDED");
});
