import { describe, expect, it } from "vitest";
import { projectDeleteTarget, noWebsiteToChangeMessage } from "../apps/agent-api/src/chat-project-delete";
describe("shared website deletion helpers", () => {
 const projects=[{id:"a",name:"Bakery Shop"},{id:"b",name:"Studio Site"}];
 it("uses the named target rather than the active project",()=>expect(projectDeleteTarget(projects,"Delete Studio Site",undefined,"a")?.id).toBe("b"));
 it("never substitutes an active project for a missing confirmed target",()=>expect(projectDeleteTarget(projects,"Yes", "Already deleted", "a")).toBeUndefined());
 it("refuses a message naming multiple possible targets",()=>expect(projectDeleteTarget(projects,"Delete Bakery Shop and Studio Site",undefined,"a")).toBeUndefined());
 it("returns the existing localized no-site message",()=>expect(noWebsiteToChangeMessage("Зміни сайт")).toContain("немає сайту"));
});
it("takes the one site named before a keep clause as the deletion target",()=>{const list=[{id:"v",name:"Stress Vite"},{id:"n",name:"Stress Next Shop"},{id:"a",name:"Stress Astro"}];expect(projectDeleteTarget(list,'Delete only the test project "Stress Vite". Keep "Stress Next Shop" and "Stress Astro".')?.id).toBe("v");expect(projectDeleteTarget(list,'Delete "Stress Vite" and "Stress Astro". Keep "Stress Next Shop".')).toBeUndefined();});
